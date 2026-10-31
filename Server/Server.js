require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });
const mongoose = require('mongoose');


// Fix: Use CommonJS require for DNS
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

async function start() {
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET.startsWith('replace-')) {
    throw new Error('Configure MONGODB_URI and a unique JWT_SECRET (at least 32 characters) in Server/.env.');
  }
  const app = require('./app');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const server = app.listen(process.env.PORT || 5000, () => console.log(`RiseTogether API listening on port ${process.env.PORT || 5000}`));
  const shutdown = () => server.close(() => mongoose.disconnect().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
start().catch(error => { console.error('Server could not start:', error.message); process.exit(1); });
