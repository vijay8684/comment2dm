// src/services/automationTimeline.js
// Structured Timeline & Performance Measurement Engine for Comment2DM Automations
// Privacy Guarantee: Never logs or stores raw Instagram account IDs, user IDs, automation IDs,
// access tokens, session cookies, passwords, comment text, or private messages.

const crypto = require('crypto');

const recordedEvents = [];
const MAX_RECORDED_EVENTS = 5000;

// Deterministic, non-reversible correlation salt (isolated to process runtime)
const TELEMETRY_SALT = process.env.TELEMETRY_SALT || crypto.randomBytes(16).toString('hex');

/**
 * Creates a deterministic, non-reversible one-way HMAC correlation hash.
 * Allows correlating distinct pipeline stages belonging to the same workflow
 * without exposing raw user, account, or automation identifiers.
 *
 * @param {string|number|null} rawId - The raw identifier to hash
 * @returns {string|null} - 12-character hexadecimal correlation reference or null
 */
function hashCorrelationId(rawId) {
  if (rawId === null || rawId === undefined || rawId === '') return null;
  const str = String(rawId).trim();
  if (!str) return null;
  return crypto.createHmac('sha256', TELEMETRY_SALT).update(str).digest('hex').slice(0, 12);
}

/**
 * Records a standardized measurement for an automation pipeline stage.
 * All raw identifiers are immediately transformed into non-reversible correlation hashes.
 *
 * Collected fields:
 * - timestamp: ISO 8601 string
 * - stage: Pipeline stage name (e.g. 'OPENING_DM_LEASE_ACQUIRED')
 * - duration_ms: Execution duration in milliseconds
 * - job_ref: Non-reversible HMAC hash of the job identifier
 * - auto_ref: Non-reversible HMAC hash of the automation identifier
 * - account_ref: Non-reversible HMAC hash of the Instagram account identifier
 * - event_type: Coarse event type ('comment', 'messaging_postback', 'messaging_text')
 * - success: Boolean outcome
 * - status_code: HTTP response code if applicable
 * - error_code: Internal or Meta API error classification code
 *
 * Strictly excluded:
 * - Raw Instagram account IDs, usernames, and profile links
 * - User IDs, passwords, session tokens, and Bearer tokens
 * - Private message text, comment text, and webhook request bodies
 *
 * @param {object} params
 * @param {string} params.stage - One of the standard stage names
 * @param {number} [params.duration_ms=0] - Duration of the stage in milliseconds
 * @param {string|number} [params.job_id] - Job event key or ID
 * @param {string|number} [params.automation_id] - Target automation ID
 * @param {string|number} [params.instagram_account_id] - Connected account identifier
 * @param {string} [params.event_type] - e.g. 'comment', 'messaging_postback', 'messaging_text'
 * @param {boolean} [params.success=true] - Stage success status
 * @param {number} [params.status_code] - HTTP status code
 * @param {string|number} [params.error_code] - Meta API or internal error code
 * @returns {object} - The recorded telemetry record
 */
function recordTimelineStage({
  stage,
  duration_ms = 0,
  job_id = null,
  automation_id = null,
  instagram_account_id = null,
  event_type = null,
  success = true,
  status_code = null,
  error_code = null
}) {
  const record = {
    timestamp: new Date().toISOString(),
    stage: String(stage || 'UNKNOWN'),
    duration_ms: Math.round(Number(duration_ms || 0) * 100) / 100,
    job_ref: hashCorrelationId(job_id),
    auto_ref: hashCorrelationId(automation_id),
    account_ref: hashCorrelationId(instagram_account_id),
    event_type: event_type ? String(event_type) : null,
    success: Boolean(success),
    status_code: status_code !== null && status_code !== undefined ? Number(status_code) : null,
    error_code: error_code !== null && error_code !== undefined ? String(error_code) : null
  };

  // Safe structured console output containing zero raw PII or user content
  console.log(`[STAGE: ${record.stage}]`, JSON.stringify(record));

  if (recordedEvents.length >= MAX_RECORDED_EVENTS) {
    recordedEvents.shift();
  }
  recordedEvents.push(record);

  return record;
}

function getRecordedTimeline() {
  return [...recordedEvents];
}

function clearRecordedTimeline() {
  recordedEvents.length = 0;
}

module.exports = {
  recordTimelineStage,
  getRecordedTimeline,
  clearRecordedTimeline,
  hashCorrelationId
};
