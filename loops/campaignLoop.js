// Import necessary modules
const moment = require("moment-timezone");
const { query } = require("../database/dbpromise");
const { getUserPlayDays } = require("../functions/function");
const { sendMessage } = require("./loopFunctions");

function delayRandom(fromSeconds, toSeconds) {
  const randomSeconds = Math.random() * (toSeconds - fromSeconds) + fromSeconds;
  return new Promise((resolve) => setTimeout(resolve, randomSeconds * 1000));
}

// Function to check if a date has passed in a given timezone
function hasDatePassedInTimezone(timezone, date) {
  const momentDate = moment.tz(date, timezone);
  const currentMoment = moment.tz(timezone);
  return momentDate.isBefore(currentMoment);
}

// Function to update the broadcast status in the database
async function updateBroadcastDatabase(status, broadcastId) {
  await query("UPDATE broadcast SET status = ? WHERE broadcast_id = ?", [
    status,
    broadcastId,
  ]);
}

// Function to process a broadcast campaign
async function processBroadcast(campaign) {
  const planDays = await getUserPlayDays(campaign?.uid);
  if (planDays < 1) {
    await updateBroadcastDatabase(
      "ACTIVE PLAN NOT FOUND",
      campaign?.broadcast_id
    );
    return;
  }

  const metaKeys = await query("SELECT * FROM meta_api WHERE uid = ?", [
    campaign?.uid,
  ]);
  if (metaKeys.length < 1) {
    await updateBroadcastDatabase("META API NOT FOUND", campaign?.broadcast_id);
    return;
  }

  // Fetch multiple pending messages instead of just one
  const logs = await query(
    "SELECT * FROM broadcast_log WHERE broadcast_id = ? AND delivery_status = ? LIMIT 10",
    [campaign?.broadcast_id, "PENDING"]
  );

  if (logs.length < 1) {
    await updateBroadcastDatabase("FINISHED", campaign?.broadcast_id);
    return;
  }

  const curTime = Date.now();

  // Process all messages in parallel
  await Promise.all(
    logs.map(async (message) => {
      const getObj = await sendMessage(message, metaKeys[0]);

      if (getObj.success) {
        await query(
          `UPDATE broadcast_log SET meta_msg_id = ?, delivery_status = ?, delivery_time = ? WHERE id = ?`,
          [getObj?.msgId, getObj.msg, curTime, message?.id]
        );
      } else {
        console.log({ getObj: JSON.stringify(getObj) });
        await query(
          `UPDATE broadcast_log SET delivery_status = ? WHERE id = ?`,
          [getObj.msg, message?.id]
        );
      }
    })
  );
}

// Function to retrieve and process broadcast campaigns
async function processBroadcasts() {
  const broadcasts = await query("SELECT * FROM broadcast WHERE status = ?", [
    "QUEUE",
  ]);

  await Promise.all(
    broadcasts.map(async (campaign) => {
      if (
        campaign.schedule &&
        hasDatePassedInTimezone(campaign?.timezone, campaign?.schedule)
      ) {
        await processBroadcast(campaign);
      }
    })
  );
}

// Function to introduce a random delay before processing broadcasts
async function runCampaign() {
  await processBroadcasts();
  await delayRandom(1, 2); // Reduce delay for faster execution
  runCampaign();
}

module.exports = { runCampaign };
