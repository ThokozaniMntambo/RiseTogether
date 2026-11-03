const mongoose = require('mongoose');
// Metadata only. A durable lease prevents parallel calls across workers/restarts.
const schema = new mongoose.Schema({
  _id: String, sessionId: String, callId: String, stopAt: Date, heartbeatAt: Date,
}, { versionKey: false });
// Never expire an uncertain provider lease automatically; the reaper confirms hangup.
module.exports = mongoose.model('RealtimeLease', schema);
