require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const express = require('express');
const { engine } = require('express-handlebars');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo').default || require('connect-mongo');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.engine('hbs', engine({ extname: '.hbs' }));
app.set('view engine', 'hbs');
app.set('views', './views');

// Yêu cầu 1 & 2: Kết nối đa luồng (Least Privilege)
const readConn = mongoose.createConnection(process.env.MONGO_URI_READ);
const writeConn = mongoose.createConnection(process.env.MONGO_URI_WRITE);

readConn.on('connected', () => console.log('MongoDB Read Connection Connected.'));
writeConn.on('connected', () => console.log('MongoDB Write Connection Connected.'));

const bookSchema = new mongoose.Schema({
  code: { type: String, required: true },
  title: { type: String, required: true },
  basePrice: { type: Number, required: true },
  finalPrice: { type: Number, required: true },
  vatRate: { type: Number, default: 8 }
});

const ReadBookModel = readConn.model('Book', bookSchema);
const WriteBookModel = writeConn.model('Book', bookSchema);

// Yêu cầu 2: Stateless Session lưu trực tiếp trên Cloud MongoDB Atlas
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI_WRITE,
      collectionName: 'sessions',
      autoRemove: 'disabled' // Tắt tính năng tự tạo Index xoá tự động để tránh dính lỗi quyền createIndex trên Atlas
    }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
  })
);

// ROUTE READ: Dùng tài khoản Read-Only xem danh sách
app.get('/', async (req, res) => {
  try {
    req.session.views = (req.session.views || 0) + 1;
    const books = await ReadBookModel.find().lean();
    res.render('index', {
      books,
      views: req.session.views,
      error: req.query.error,
      success: req.query.success
    });
  } catch (err) {
    res.status(500).send('Lỗi khi đọc dữ liệu: ' + err.message);
  }
});

// ROUTE WRITE: Dùng tài khoản Write-Only thêm sách
app.post('/add-book', async (req, res) => {
  const { code, title, basePrice } = req.body;

  // Thuật toán cá nhân hóa 1: Tiền tố bắt buộc = 272 (3 số cuối MSSV)
  const PREFIX = '272';
  if (!code || !code.startsWith(PREFIX)) {
    return res.redirect(`/?error=Mã sách không hợp lệ! Phải bắt đầu bằng tiền tố ${PREFIX}`);
  }

  // Thuật toán cá nhân hóa 2: VAT = (Chữ số cuối MSSV + 6)% = (2 + 6)% = 8%
  const VAT_RATE = 2 + 6;
  const basePriceNum = parseFloat(basePrice);
  const finalPrice = basePriceNum + (basePriceNum * VAT_RATE) / 100;

  try {
    const newBook = new WriteBookModel({
      code,
      title,
      basePrice: basePriceNum,
      finalPrice,
      vatRate: VAT_RATE
    });

    await newBook.save();
    res.redirect('/?success=Thêm sách thành công!');
  } catch (err) {
    res.redirect(`/?error=Lỗi khi ghi dữ liệu: ${encodeURIComponent(err.message)}`);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});