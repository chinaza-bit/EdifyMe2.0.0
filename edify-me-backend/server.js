require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes = require('./src/routes/auth.routes');
const userRoutes = require('./src/routes/users.routes');
const postRoutes = require('./src/routes/posts.routes');

const app = express();

// credentials:true + an explicit origin (not "*") are both required for
// the browser to accept/send the httpOnly session cookie cross-origin.
app.use(cors({ origin: process.env.CLIENT_URL || 'http://127.0.0.1:5500', credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '8mb' })); // generous limit for base64 image uploads

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);

// centralized error fallback
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Edify Me API running on http://localhost:${PORT}`));
