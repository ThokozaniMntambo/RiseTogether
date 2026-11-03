const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const OpenAI = require('openai');
const { inspect, model, transcriptionModel } = require('../services/realtimeConfig');
const { fields, diagnose } = require('../services/realtimeDiagnostics');
const { policy, planningEstimate } = require('../services/realtimeCost');

async function main() {
  const { failures, ...configuration } = inspect();
  console.log(JSON.stringify({ configuration, blockers: failures.map(e => ({ code: e.code, message: e.message })),
    costPlan: planningEstimate(),
    warnings: configuration.sharedBudgetUsd < (policy.minReserveMicros + policy.feedbackReserveMicros) / 1e6 ? ['The shared AI budget cannot fit the minimum voice plus feedback reservation.'] : [],
    notes: ['No session created, quota reserved or raw credentials printed.', 'Approved-account count does not establish that the signed-in user is allowlisted.', 'The persistent shared budget may have less remaining capacity than the configured ceiling.'] }, null, 2));
  if (process.argv.includes('--check-budget')) {
    const mongoose = require('mongoose');
    try {
      if (!process.env.MONGODB_URI) throw new Error('Missing database configuration');
      // Match Server.js: this workspace uses these resolvers for Atlas SRV lookups.
      require('node:dns').setServers(['8.8.8.8', '8.8.4.4']);
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
      const amount = Math.max(policy.minReserveMicros, (configuration.reserveUsd || 0) * 1e6) + policy.feedbackReserveMicros;
      console.log(JSON.stringify({ check: 'persistent_application_budget', ...(await require('../services/aiUsage').budgetSnapshot(amount)) }, null, 2));
      console.log('This snapshot is read-only and excludes per-user quota buckets. Session creation enforces those atomically. Application reservations are not OpenAI credit balances.');
    } catch (error) {
      const errorType = ['MongoServerSelectionError', 'MongoParseError', 'MongoAPIError', 'MongoServerError', 'Error'].includes(error.name) ? error.name : 'DatabaseError';
      console.log(JSON.stringify({ check: 'persistent_application_budget', databaseStatus: 'unavailable', errorType, errorCode: fields(error).errorCode, message: 'Could not read the database. No budget was assumed available and no quota data was modified.' })); process.exitCode = 1;
    }
    finally { await mongoose.disconnect(); }
  }
  if (!process.argv.includes('--check-provider')) {
    console.log('Provider checks not requested. After configuring the dedicated key, use npm run realtime:diagnose -- --check-provider for read-only model checks.');
    return;
  }
  if (!configuration.realtimeKeyPresent) { console.log('Provider checks skipped: OPENAI_REALTIME_API_KEY is missing. The standard key is not a fallback.'); return; }
  const provider = new OpenAI({ apiKey: process.env.OPENAI_REALTIME_API_KEY, timeout: 10000, maxRetries: 0 });
  for (const name of [model, transcriptionModel]) {
    try {
      const { response } = await provider.models.retrieve(name).withResponse();
      console.log(JSON.stringify({ check: 'model_visibility', model: name, status: response.status, ...fields({ request_id: response.headers.get('x-request-id') }) }));
    } catch (error) {
      console.log(JSON.stringify({ check: 'model_visibility', model: name, ...fields(error), result: diagnose(error).code }));
    }
  }
  console.log('Model visibility does not prove Realtime write permission, credit availability or successful audio negotiation. No billable Realtime call was attempted. Verify project permissions, model usage, billing and enforced spend limit in the OpenAI console.');
}
main().catch(() => { console.error('Realtime diagnostics could not complete. No raw error payload was printed.'); process.exitCode = 1; });
