// src/services/automationTimeline.js
// Structured Timeline & Performance Measurement Engine for Comment2DM Automations

const recordedEvents = [];
const MAX_RECORDED_EVENTS = 5000;

/**
 * Records a standardized measurement for an automation pipeline stage.
 * Never logs access tokens, session cookies, passwords, or private user conversations.
 *
 * @param {object} params
 * @param {string} params.stage - One of the 16 standard stage names
 * @param {number} params.duration_ms - Duration of the stage in milliseconds
 * @param {string} [params.job_id] - Job event key or ID
 * @param {string} [params.automation_id] - Target automation ID
 * @param {string} [params.instagram_account_id] - Connected account identifier
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
    stage,
    duration_ms: Math.round(Number(duration_ms) * 100) / 100,
    job_id: job_id ? String(job_id) : null,
    automation_id: automation_id ? String(automation_id) : null,
    instagram_account_id: instagram_account_id ? String(instagram_account_id) : null,
    event_type: event_type ? String(event_type) : null,
    success: Boolean(success),
    status_code: status_code ? Number(status_code) : null,
    error_code: error_code ? String(error_code) : null
  };

  console.log(`[STAGE: ${stage}]`, JSON.stringify(record));

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
  clearRecordedTimeline
};
