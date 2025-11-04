const { query } = require("../database/dbpromise");
const { sendTemplateMessage } = require("../functions/function");

// Processing flags per user to prevent overlapping
const userProcessingFlags = new Map();
// Configurable settings
const CONFIG = {
  batchSize: 50, // Increased from 20 to 50 logs per batch
  checkInterval: 5000, // Check every 5 seconds
  maxCampaignsPerCycle: 15, // Process up to 15 campaigns per cycle
  messageDelay: 500, // Reduced delay between messages to 500ms
  maxRetries: 3, // Maximum retry attempts for failed messages
  fairnessWindow: 10 * 60 * 1000, // 10 minutes window for fairness algorithm
};

// Track last processed time per user for fairness
const userLastProcessedTime = new Map();

/**
 * Initialize the campaign processing system
 */
async function initCampaign() {
  console.log(
    "Campaign Beta initialization started with enhanced multi-user support"
  );

  // Set up interval to process campaigns
  const interval = setInterval(async () => {
    try {
      await processPendingCampaigns();
    } catch (error) {
      console.error("Error in campaign processing loop:", error);
    }
  }, CONFIG.checkInterval);

  // Initial run
  try {
    await processPendingCampaigns();
  } catch (error) {
    console.error("Error processing campaigns on initial run:", error);
  }

  return interval;
}

/**
 * Process all pending campaigns with user fairness
 */
async function processPendingCampaigns() {
  try {
    // Get all users with pending campaigns
    const usersWithPendingCampaigns = await query(
      `SELECT DISTINCT uid FROM beta_campaign 
       WHERE status = 'PENDING' OR status = 'IN_PROGRESS'
       ORDER BY createdAt ASC`,
      []
    );

    if (!usersWithPendingCampaigns || usersWithPendingCampaigns.length === 0) {
      return;
    }

    // Sort users by last processed time (fairness algorithm)
    const sortedUsers = [...usersWithPendingCampaigns].sort((a, b) => {
      const timeA = userLastProcessedTime.get(a.uid) || 0;
      const timeB = userLastProcessedTime.get(b.uid) || 0;
      return timeA - timeB;
    });

    // Process campaigns for each user in a fair manner
    for (const userObj of sortedUsers) {
      const uid = userObj.uid;

      // Skip if this user is already being processed
      if (userProcessingFlags.get(uid)) {
        continue;
      }

      try {
        userProcessingFlags.set(uid, true);
        await processUserCampaigns(uid);
        // Update last processed time for this user
        userLastProcessedTime.set(uid, Date.now());
      } finally {
        userProcessingFlags.set(uid, false);
      }
    }
  } catch (error) {
    console.error("Error in processPendingCampaigns:", error);
  }
}

/**
 * Process campaigns for a specific user
 */
async function processUserCampaigns(uid) {
  // Get pending campaigns for this user
  const pendingCampaigns = await query(
    `SELECT * FROM beta_campaign 
     WHERE uid = ? AND (status = 'PENDING' OR status = 'IN_PROGRESS') 
     ORDER BY createdAt ASC LIMIT ?`,
    [uid, CONFIG.maxCampaignsPerCycle]
  );

  if (!pendingCampaigns || pendingCampaigns.length === 0) {
    return;
  }

  console.log(
    `Processing ${pendingCampaigns.length} campaigns for user ${uid}`
  );

  // Process each campaign
  for (const campaign of pendingCampaigns) {
    try {
      await processSingleCampaign(campaign);
    } catch (campaignError) {
      console.error(
        `Error processing campaign ${campaign.campaign_id}:`,
        campaignError
      );
    }
  }
}

/**
 * Process a single campaign
 */
async function processSingleCampaign(campaign) {
  console.log(`Processing campaign: ${campaign.campaign_id}`);

  // Skip if scheduled for future
  if (campaign.schedule) {
    const scheduleTime = new Date(campaign.schedule).getTime();
    const now = new Date().getTime();
    if (scheduleTime > now) {
      console.log(
        `Campaign ${campaign.campaign_id} scheduled for future, skipping`
      );
      return;
    }
  }

  // Update status to IN_PROGRESS if it's PENDING
  if (campaign.status === "PENDING") {
    await query(
      "UPDATE beta_campaign SET status = 'IN_PROGRESS' WHERE campaign_id = ?",
      [campaign.campaign_id]
    );
    console.log(
      `Campaign ${campaign.campaign_id} status updated to IN_PROGRESS`
    );
  }

  // Get all contacts that haven't been processed yet
  const contactsToProcess = await query(
    `SELECT c.* FROM contact c
     LEFT JOIN beta_campaign_logs l ON c.mobile = l.contact_mobile AND l.campaign_id = ?
     WHERE c.uid = ? AND c.phonebook_id = ? AND l.id IS NULL
     LIMIT ?`,
    [
      campaign.campaign_id,
      campaign.uid,
      campaign.phonebook_id,
      CONFIG.batchSize,
    ]
  );

  // Get pending logs for this campaign
  const pendingLogs = await query(
    "SELECT * FROM beta_campaign_logs WHERE campaign_id = ? AND status = 'PENDING' LIMIT ?",
    [campaign.campaign_id, CONFIG.batchSize]
  );

  // Check if we need to retry failed messages
  if (pendingLogs.length === 0 && contactsToProcess.length === 0) {
    const failedLogs = await query(
      `SELECT * FROM beta_campaign_logs 
       WHERE campaign_id = ? AND status = 'FAILED' 
       AND retry_count < ?
       LIMIT ?`,
      [campaign.campaign_id, CONFIG.maxRetries, CONFIG.batchSize]
    );

    if (failedLogs && failedLogs.length > 0) {
      console.log(
        `Retrying ${failedLogs.length} failed messages for campaign ${campaign.campaign_id}`
      );

      // Reset failed logs to pending for retry
      const failedIds = failedLogs.map((log) => log.id);
      await query(
        `UPDATE beta_campaign_logs 
         SET status = 'PENDING', 
             retry_count = retry_count + 1,
             error_message = CONCAT('Retry #', retry_count + 1, ': ', IFNULL(error_message, '')) 
         WHERE id IN (?)`,
        [failedIds]
      );

      // Process these newly pending logs
      await processLogsForCampaign(campaign, failedLogs);
      return;
    }
  }

  // Check if campaign is complete
  if (pendingLogs.length === 0 && contactsToProcess.length === 0) {
    const [totalLogs] = await query(
      "SELECT COUNT(*) as count FROM beta_campaign_logs WHERE campaign_id = ?",
      [campaign.campaign_id]
    );

    const [totalContacts] = await query(
      "SELECT COUNT(*) as count FROM contact WHERE uid = ? AND phonebook_id = ?",
      [campaign.uid, campaign.phonebook_id]
    );

    // Mark as complete if we've processed all contacts or have no more to process
    if (
      totalLogs.count >= Math.min(campaign.total_contacts, totalContacts.count)
    ) {
      await query(
        "UPDATE beta_campaign SET status = 'COMPLETED' WHERE campaign_id = ?",
        [campaign.campaign_id]
      );
      console.log(
        `Campaign ${campaign.campaign_id} marked as COMPLETED - all messages processed`
      );
      return;
    }
  }

  // If we have pending logs, process them first
  if (pendingLogs && pendingLogs.length > 0) {
    await processLogsForCampaign(campaign, pendingLogs);
    return;
  }

  // If we have new contacts, create logs for them
  if (contactsToProcess && contactsToProcess.length > 0) {
    console.log(
      `Creating logs for ${contactsToProcess.length} new contacts in campaign ${campaign.campaign_id}`
    );

    // Batch insert logs for better performance
    const values = contactsToProcess.map((contact) => [
      campaign.uid,
      campaign.campaign_id,
      contact.name.replace(/'/g, "''").replace(/\\/g, "\\\\"),
      contact.mobile,
      "PENDING",
    ]);

    await query(
      `INSERT INTO beta_campaign_logs 
       (uid, campaign_id, contact_name, contact_mobile, status) 
       VALUES ?`,
      [values]
    );

    console.log(
      `Created ${contactsToProcess.length} new logs for campaign ${campaign.campaign_id}`
    );

    // Get the newly created logs
    const newLogs = await query(
      "SELECT * FROM beta_campaign_logs WHERE campaign_id = ? AND status = 'PENDING' LIMIT ?",
      [campaign.campaign_id, CONFIG.batchSize]
    );

    // Process the new logs
    if (newLogs && newLogs.length > 0) {
      await processLogsForCampaign(campaign, newLogs);
    }
  }
}

/**
 * Process logs for a campaign
 */
async function processLogsForCampaign(campaign, logs) {
  console.log(
    `Processing ${logs.length} logs for campaign ${campaign.campaign_id}`
  );

  // Get meta API credentials once for all logs
  const metaCredentials = await query("SELECT * FROM meta_api WHERE uid = ?", [
    campaign.uid,
  ]);

  if (!metaCredentials || metaCredentials.length === 0) {
    // Bulk update all logs as failed
    const logIds = logs.map((log) => log.id);
    await query(
      "UPDATE beta_campaign_logs SET status = 'FAILED', error_message = 'Meta API credentials not found' WHERE id IN (?)",
      [logIds]
    );

    // Update campaign stats
    await query(
      "UPDATE beta_campaign SET failed_count = failed_count + ? WHERE campaign_id = ?",
      [logs.length, campaign.campaign_id]
    );

    console.log(
      `Failed to send messages: Meta API credentials not found for user ${campaign.uid}`
    );
    return;
  }

  // Parse variables from campaign once
  let bodyVariables = [];
  let headerVariable = null;
  let buttonVariables = [];

  try {
    bodyVariables = campaign.body_variables
      ? JSON.parse(campaign.body_variables)
      : [];
    headerVariable = campaign.header_variable
      ? JSON.parse(campaign.header_variable)
      : null;
    buttonVariables = campaign.button_variables
      ? JSON.parse(campaign.button_variables)
      : [];
  } catch (e) {
    console.error(`Error parsing campaign variables: ${e.message}`);
  }

  // Process logs in batches for better performance
  const apiVersion = "v18.0";
  const credentials = metaCredentials[0];
  const successfulLogs = [];
  const failedLogs = [];

  for (const log of logs) {
    try {
      // Get contact details for this log
      const contactDetails = await query(
        "SELECT * FROM contact WHERE mobile = ? AND uid = ? AND phonebook_id = ? LIMIT 1",
        [log.contact_mobile, campaign.uid, campaign?.phonebook_id]
      );

      const contact =
        contactDetails && contactDetails.length > 0
          ? contactDetails[0]
          : {
              name: log.contact_name,
              mobile: log.contact_mobile,
              var1: "",
              var2: "",
              var3: "",
              var4: "",
              var5: "",
            };

      // Replace variables with contact data
      const processedBodyVars = replaceContactVariables(bodyVariables, contact);
      const processedHeaderVar = replaceContactVariable(
        headerVariable,
        contact
      );
      const processedButtonVars = replaceContactVariables(
        buttonVariables,
        contact
      );

      // Send the template message
      const result = await sendTemplateMessage(
        apiVersion,
        credentials.business_phone_number_id,
        credentials.access_token,
        campaign.template_name,
        campaign.template_language,
        log.contact_mobile,
        processedBodyVars,
        processedHeaderVar,
        processedButtonVars
      );

      if (result && result.messages && result.messages.length > 0) {
        const messageId = result.messages[0].id;
        successfulLogs.push({ id: log.id, messageId });
      } else {
        const errorMsg =
          result && result.error
            ? `${result.error.message || "Unknown error"}`
            : "No message ID returned";
        failedLogs.push({ id: log.id, error: errorMsg });
      }

      // Add a small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, CONFIG.messageDelay));
    } catch (error) {
      console.error(
        `Error sending campaign message to ${log.contact_mobile}: ${error.message}`
      );
      failedLogs.push({ id: log.id, error: error.message });
    }
  }

  // Bulk update successful logs
  if (successfulLogs.length > 0) {
    for (const batch of chunkArray(successfulLogs, 100)) {
      const updates = batch
        .map((log) => `WHEN ${log.id} THEN '${log.messageId}'`)
        .join(" ");

      const ids = batch.map((log) => log.id);

      await query(
        `UPDATE beta_campaign_logs 
         SET status = 'SENT', 
             meta_msg_id = CASE id ${updates} END
         WHERE id IN (?)`,
        [ids]
      );
    }

    // Update campaign stats
    await query(
      "UPDATE beta_campaign SET sent_count = sent_count + ? WHERE campaign_id = ?",
      [successfulLogs.length, campaign.campaign_id]
    );

    console.log(
      `Successfully sent ${successfulLogs.length} messages for campaign ${campaign.campaign_id}`
    );
  }

  // Bulk update failed logs
  if (failedLogs.length > 0) {
    for (const batch of chunkArray(failedLogs, 100)) {
      const updates = batch
        .map((log) => `WHEN ${log.id} THEN ${mysql.escape(log.error)}`)
        .join(" ");

      const ids = batch.map((log) => log.id);

      await query(
        `UPDATE beta_campaign_logs 
         SET status = 'FAILED', 
             error_message = CASE id ${updates} END
         WHERE id IN (?)`,
        [ids]
      );
    }

    // Update campaign stats
    await query(
      "UPDATE beta_campaign SET failed_count = failed_count + ? WHERE campaign_id = ?",
      [failedLogs.length, campaign.campaign_id]
    );

    console.log(
      `Failed to send ${failedLogs.length} messages for campaign ${campaign.campaign_id}`
    );
  }

  // Check if campaign is completed after processing logs
  await checkCampaignCompletion(campaign);
}

/**
 * Check if a campaign is completed
 */
async function checkCampaignCompletion(campaign) {
  const [pendingCount] = await query(
    "SELECT COUNT(*) as count FROM beta_campaign_logs WHERE campaign_id = ? AND status = 'PENDING'",
    [campaign.campaign_id]
  );

  const [totalCount] = await query(
    "SELECT COUNT(*) as count FROM beta_campaign_logs WHERE campaign_id = ?",
    [campaign.campaign_id]
  );

  const [contactCount] = await query(
    "SELECT COUNT(*) as count FROM contact WHERE uid = ? AND phonebook_id = ?",
    [campaign.uid, campaign.phonebook_id]
  );

  // Mark as complete if all messages are sent or if we've sent to all available contacts
  if (
    pendingCount.count === 0 &&
    totalCount.count >= Math.min(campaign.total_contacts, contactCount.count)
  ) {
    await query(
      "UPDATE beta_campaign SET status = 'COMPLETED' WHERE campaign_id = ?",
      [campaign.campaign_id]
    );
    console.log(
      `Campaign ${campaign.campaign_id} marked as COMPLETED - all messages processed`
    );
  }
}

/**
 * Replace contact variables in an array of variables
 */
function replaceContactVariables(variables, contact) {
  if (!Array.isArray(variables)) return variables;

  return variables.map((variable) => replaceContactVariable(variable, contact));
}

/**
 * Replace contact variable in a single variable
 */
function replaceContactVariable(variable, contact) {
  if (typeof variable !== "string") return variable;

  const varMatch = variable.match(/\{\{\{([a-zA-Z0-9_]+)\}\}\}/);
  if (!varMatch || !varMatch[1]) return variable;

  const contactVarName = varMatch[1];

  if (contactVarName === "name" && contact.name) {
    return contact.name;
  } else if (contactVarName === "mobile" && contact.mobile) {
    return contact.mobile;
  } else if (contactVarName.startsWith("var") && contactVarName.length === 4) {
    const varNumber = contactVarName.charAt(3);
    if (
      ["1", "2", "3", "4", "5"].includes(varNumber) &&
      contact[`var${varNumber}`]
    ) {
      return contact[`var${varNumber}`];
    }
  }

  return variable;
}

/**
 * Split array into chunks for batch processing
 */
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Handle webhook updates for message status
 */

async function updateMessageStatus(metaMsgId, status) {
  try {
    await new Promise((res) => setTimeout(res, 10000));

    // Find the campaign log with this message ID
    const logs = await query(
      "SELECT * FROM beta_campaign_logs WHERE meta_msg_id = ?",
      [metaMsgId]
    );

    if (!logs || logs.length === 0) {
      console.log(`No log found for message ID: ${metaMsgId}`);
      return;
    }

    const log = logs[0];
    console.log(`Updating message ${metaMsgId} status to ${status}`);

    // SIMPLE FIX: Only update if status is different
    if (log.delivery_status === status) {
      console.log(
        `Message ${metaMsgId} already has status ${status}, skipping`
      );
      return;
    }

    // Update the log status
    await query(
      "UPDATE beta_campaign_logs SET delivery_status = ?, delivery_time = ? WHERE meta_msg_id = ?",
      [status, new Date().toISOString(), metaMsgId]
    );

    // SIMPLE FIX: Only increment counters for new status changes
    if (status === "delivered" && log.delivery_status !== "delivered") {
      await query(
        "UPDATE beta_campaign SET delivered_count = delivered_count + 1 WHERE campaign_id = ?",
        [log.campaign_id]
      );
    } else if (status === "read" && log.delivery_status !== "read") {
      await query(
        "UPDATE beta_campaign SET read_count = read_count + 1 WHERE campaign_id = ?",
        [log.campaign_id]
      );
    }
  } catch (error) {
    console.error(
      `Error updating message status for ${metaMsgId}: ${error.message}`
    );
  }
}

// Don't forget to add mysql for escaping
const mysql = require("mysql2");

module.exports = { initCampaign, updateMessageStatus };
