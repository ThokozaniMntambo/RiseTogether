const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  _id: { type: String },
  count: { type: Number, default: 0 },
  reservedMicros: { type: Number, default: 0 },
  expiresAt: Date,
}, { versionKey: false });
// Only per-user time buckets expire. The global budget never resets automatically.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('AiUsage', schema);
