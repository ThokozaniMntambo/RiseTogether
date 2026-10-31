const mongoose = require('mongoose');

const careerSessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  profile: {
    education: { type: String, required: true, maxlength: 1000 },
    interests: { type: String, required: true, maxlength: 1000 },
    skills: { type: String, required: true, maxlength: 1000 },
    experience: { type: String, required: true, maxlength: 1000 },
    goals: { type: String, required: true, maxlength: 1000 },
    constraints: { type: String, maxlength: 1000, default: '' },
  },
  guidance: { type: mongoose.Schema.Types.Mixed, required: true },
  model: { type: String, required: true },
}, { timestamps: true });
careerSessionSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('CareerSession', careerSessionSchema);
