const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const bcrypt = require("bcrypt");
const {
  createMetaTemplet,
  getMetaNumberDetail,
} = require("../functions/function.js");
const { sign } = require("jsonwebtoken");
const validateUser = require("../middlewares/user.js");
const { checkPlan } = require("../middlewares/plan.js");

// adding campaign
router.post("/add_new", validateUser, checkPlan, async (req, res) => {
  try {
    const { title, templet, phonebook, scheduleTimestamp, example } = req.body;

    if (!title || !templet?.name || !phonebook || !scheduleTimestamp) {
      return res.json({ success: false, msg: "Please enter all details" });
    }

    const { id } = phonebook;

    if (!id) {
      return res.json({ msg: "Invalid phonebook provided" });
    }

    const getMetaAPI = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      req.decode.uid,
    ]);

    if (getMetaAPI.length < 1) {
      return res.json({ msg: "We could not find your meta API keys" });
    }

    const getPhonebookContacts = await query(
      `SELECT * FROM contact where phonebook_id = ? AND uid = ?`,
      [id, req.decode.uid]
    );

    if (getPhonebookContacts.length < 1) {
      return res.json({
        success: false,
        msg: "The phonebook you have selected does not have any mobile number in it",
      });
    }

    const getMetaMobileDetails = await getMetaNumberDetail(
      "v18.0",
      getMetaAPI[0]?.business_phone_number_id,
      getMetaAPI[0]?.access_token
    );

    if (getMetaMobileDetails.error) {
      return res.json({
        success: false,
        msg: "Either your meta API are invalid or your access token has been expired",
      });
    }

    const broadcast_id = randomstring.generate();

    const broadcast_logs = getPhonebookContacts.map((i) => [
      req.decode.uid,
      broadcast_id,
      templet?.name || "NA",
      getMetaMobileDetails?.display_phone_number,
      i?.mobile,
      "PENDING",
      JSON.stringify(example),
      JSON.stringify(i),
    ]);

    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [
      req.decode.uid,
    ]);

    await query(
      `
                INSERT INTO broadcast_log (
                    uid,
                    broadcast_id,
                    templet_name,
                    sender_mobile,
                    send_to,
                    delivery_status,
                    example,
                    contact
                ) VALUES ?`,
      [broadcast_logs]
    );

    const scheduleDate = scheduleTimestamp ? new Date(scheduleTimestamp) : null;

    await query(
      `INSERT INTO broadcast (broadcast_id, uid, title, templet, phonebook, status, schedule, timezone) VALUES (
            ?,?,?,?,?,?,?,?
        )`,
      [
        broadcast_id,
        req.decode.uid,
        title,
        JSON.stringify(templet),
        JSON.stringify(phonebook),
        "QUEUE",
        scheduleDate,
        getUser[0]?.timezone || "Asia/Kolkata",
      ]
    );

    res.json({ success: true, msg: "Your broadcast has been added" });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// get all campaign
router.get("/get_broadcast", validateUser, async (req, res) => {
  try {
    const data = await query(`SELECT * FROM broadcast WHERE uid = ?`, [
      req.decode.uid,
    ]);
    res.json({ data, success: true });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// get broadcast logs by bid
router.post("/get_broadcast_logs", validateUser, async (req, res) => {
  try {
    const { id } = req.body;

    const data = await query(
      `SELECT * FROM broadcast_log WHERE broadcast_id = ? AND uid = ?`,
      [id, req.decode.uid]
    );

    const getSent = data?.filter((i) => i.delivery_status === "sent");

    const totalDelivered = data?.filter(
      (i) => i.delivery_status === "delivered"
    );

    const totalRead = data?.filter((i) => i.delivery_status === "read");
    const totalFailed = data?.filter((i) => i.delivery_status === "failed");

    const totalPending = data?.filter((i) => i.delivery_status === "PENDING");

    console.log({
      totalLogs: data?.length,
      getSent: getSent?.length,
      totalRead: totalRead?.length,
      totalFailed: totalFailed?.length,
      totalPending: totalPending?.length,
      totalDelivered: totalDelivered?.length,
    });

    res.json({
      data,
      success: true,
      totalLogs: data?.length,
      getSent: getSent?.length,
      totalRead: totalRead?.length,
      totalFailed: totalFailed?.length,
      totalPending: totalPending?.length,
      totalDelivered: totalDelivered?.length,
    });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// change campaign status
router.post("/change_broadcast_status", validateUser, async (req, res) => {
  try {
    console.log(req.body);
    const { status, broadcast_id } = req.body;

    if (!status) {
      return res.json({ msg: "Invalid request" });
    }

    await query(
      `UPDATE broadcast SET status = ? WHERE broadcast_id = ? AND uid = ?`,
      [status, broadcast_id, req.decode.uid]
    );
    res.json({ success: true, msg: "Campaign status updated" });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// delete a broad cast
router.post("/del_broadcast", validateUser, async (req, res) => {
  try {
    const { broadcast_id } = req.body;

    await query(`DELETE FROM broadcast WHERE uid = ? AND broadcast_id = ?`, [
      req.decode.uid,
      broadcast_id,
    ]);
    await query(
      `DELETE FROM broadcast_log WHERE uid = ? AND broadcast_id = ?`,
      [req.decode.uid, broadcast_id]
    );

    res.json({ success: true, msg: "Broadcast was deleted" });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

router.post(
  "/create_template_campaign",
  validateUser,
  checkPlan,
  async (req, res) => {
    try {
      const {
        template_name,
        template_language,
        phonebook_id,
        campaign_title,
        body_variables,
        header_variable,
        button_variables,
        schedule,
        timezone,
      } = req.body;

      // Validate required fields
      if (
        !template_name ||
        !template_language ||
        !phonebook_id ||
        !campaign_title
      ) {
        return res.json({
          success: false,
          msg: "Missing required fields",
        });
      }

      // Get phonebook details
      const phonebooks = await query(
        "SELECT * FROM phonebook WHERE id = ? AND uid = ?",
        [phonebook_id, req.decode.uid]
      );

      if (!phonebooks || phonebooks.length === 0) {
        return res.json({
          success: false,
          msg: "Phonebook not found",
        });
      }

      // Count contacts in phonebook
      const contactsCount = await query(
        "SELECT COUNT(*) as count FROM contact WHERE phonebook_id = ? AND uid = ?",
        [phonebook_id, req.decode.uid]
      );

      if (!contactsCount || contactsCount[0].count === 0) {
        return res.json({
          success: false,
          msg: "No contacts found in the selected phonebook",
        });
      }

      // Generate campaign ID
      const campaignId = randomstring.generate(10);

      // Create campaign record
      await query(
        `INSERT INTO beta_campaign (
        campaign_id, uid, title, template_name, template_language,
        phonebook_id, phonebook_name, status, total_contacts,
        body_variables, header_variable, button_variables, schedule, timezone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
        [
          campaignId,
          req.decode.uid,
          campaign_title,
          template_name,
          template_language,
          phonebook_id,
          phonebooks[0].name,
          contactsCount[0].count,
          JSON.stringify(body_variables || []),
          JSON.stringify(header_variable || null),
          JSON.stringify(button_variables || []),
          schedule || null,
          timezone || null,
        ]
      );

      return res.json({
        success: true,
        msg: "Campaign created successfully",
        campaignId,
      });
    } catch (error) {
      console.error("Error creating campaign:", error);
      return res.json({
        success: false,
        msg: "An error occurred while creating the campaign",
      });
    }
  }
);

// Get all campaigns for the user
router.get("/get_campaigns", validateUser, checkPlan, async (req, res) => {
  try {
    const campaigns = await query(
      "SELECT * FROM beta_campaign WHERE uid = ? ORDER BY createdAt DESC",
      [req.decode.uid]
    );

    return res.json({
      success: true,
      data: campaigns,
    });
  } catch (error) {
    console.error("Error fetching campaigns:", error);
    return res.json({
      success: false,
      msg: "An error occurred while fetching campaigns",
    });
  }
});

// Get campaign details including logs
router.get(
  "/get_campaign_details/:campaignId",
  validateUser,
  checkPlan,
  async (req, res) => {
    try {
      const { campaignId } = req.params;

      // Get campaign
      const campaigns = await query(
        "SELECT * FROM beta_campaign WHERE campaign_id = ? AND uid = ?",
        [campaignId, req.decode.uid]
      );

      if (!campaigns || campaigns.length === 0) {
        return res.json({
          success: false,
          msg: "Campaign not found",
        });
      }

      // Get logs
      const logs = await query(
        "SELECT * FROM beta_campaign_logs WHERE campaign_id = ? ORDER BY createdAt DESC",
        [campaignId]
      );

      return res.json({
        success: true,
        campaign: campaigns[0],
        logs,
      });
    } catch (error) {
      console.error("Error fetching campaign details:", error);
      return res.json({
        success: false,
        msg: "An error occurred while fetching campaign details",
      });
    }
  }
);

// Get all campaigns for a user
router.get("/campaigns", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid; // Note: Fixed typo from req.decode to req.decoded

    const campaigns = await query(
      `
      SELECT 
        c.*, 
        COALESCE(c.sent_count, 0) as sent_count,
        COALESCE(c.delivered_count, 0) as delivered_count,
        COALESCE(c.read_count, 0) as read_count,
        COALESCE(c.failed_count, 0) as failed_count,
        p.name as phonebook_name
      FROM beta_campaign c
      LEFT JOIN phonebook p ON c.phonebook_id = p.id
      WHERE c.uid = ?
      ORDER BY c.createdAt DESC
      LIMIT 50
    `,
      [uid]
    );

    res.json({ success: true, campaigns });
  } catch (error) {
    console.error("Error fetching campaigns:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch campaigns" });
  }
});

// Get detailed stats for a specific campaign
router.get("/campaign/:campaignId", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid;
    const { campaignId } = req.params;

    // Verify campaign belongs to user
    const campaign = await query(
      `
      SELECT * FROM beta_campaign WHERE campaign_id = ? AND uid = ?
    `,
      [campaignId, uid]
    );

    if (!campaign || campaign.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    // Get detailed stats
    const stats = await query(
      `
      SELECT 
        status,
        delivery_status,
        COUNT(*) as count,
        DATE_FORMAT(createdAt, '%Y-%m-%d %H:00:00') as hour
      FROM beta_campaign_logs
      WHERE campaign_id = ?
      GROUP BY status, delivery_status, hour
      ORDER BY hour
    `,
      [campaignId]
    );

    // Get recent logs
    const logs = await query(
      `
      SELECT * FROM beta_campaign_logs
      WHERE campaign_id = ?
      ORDER BY createdAt DESC
      LIMIT 100
    `,
      [campaignId]
    );

    res.json({
      success: true,
      campaign: campaign[0],
      stats,
      logs,
    });
  } catch (error) {
    console.error("Error fetching campaign details:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch campaign details" });
  }
});

// Get dashboard summary stats
router.get("/dashboard", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid;

    // Get total campaigns
    const totalCampaigns = await query(
      `SELECT COUNT(*) as count FROM beta_campaign WHERE uid = ?`,
      [uid]
    );

    // Get total messages - Fixed query
    const totalMessages = await query(
      `SELECT 
        SUM(sent_count) as sent,
        SUM(delivered_count) as delivered,
        SUM(read_count) as \`read\`,
        SUM(failed_count) as failed
      FROM beta_campaign
      WHERE uid = ?`,
      [uid]
    );

    // Get campaigns by status
    const campaignsByStatus = await query(
      `SELECT status, COUNT(*) as count
      FROM beta_campaign
      WHERE uid = ?
      GROUP BY status`,
      [uid]
    );

    // Get daily stats for the last 30 days
    const dailyStats = await query(
      `SELECT 
        DATE(createdAt) as date,
        COUNT(*) as total_messages,
        SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN delivery_status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN delivery_status = 'read' THEN 1 ELSE 0 END) as \`read\`
      FROM beta_campaign_logs
      WHERE uid = ? AND createdAt > DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(createdAt)
      ORDER BY date`,
      [uid]
    );

    // Get recent campaigns - Fixed JOIN
    const recentCampaigns = await query(
      `SELECT 
        c.*,
        p.name as phonebook_name
      FROM beta_campaign c
      LEFT JOIN phonebook p ON c.phonebook_id = p.id
      WHERE c.uid = ?
      ORDER BY c.createdAt DESC
      LIMIT 5`,
      [uid]
    );

    res.json({
      success: true,
      totalCampaigns: totalCampaigns[0].count,
      messageStats: totalMessages[0],
      campaignsByStatus,
      dailyStats,
      recentCampaigns,
    });
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch dashboard data" });
  }
});

// Export campaign logs to CSV
router.get("/export/:campaignId", validateUser, async (req, res) => {
  try {
    const uid = req.decoded.uid;
    const { campaignId } = req.params;

    // Verify campaign belongs to user
    const campaign = await query(
      `
      SELECT * FROM beta_campaign WHERE campaign_id = ? AND uid = ?
    `,
      [campaignId, uid]
    );

    if (!campaign || campaign.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    // Get all logs
    const logs = await query(
      `
      SELECT 
        contact_name,
        contact_mobile,
        status,
        delivery_status,
        error_message,
        createdAt,
        delivery_time
      FROM beta_campaign_logs
      WHERE campaign_id = ?
      ORDER BY createdAt
    `,
      [campaignId]
    );

    // Convert to CSV format
    const fields = [
      "contact_name",
      "contact_mobile",
      "status",
      "delivery_status",
      "error_message",
      "createdAt",
      "delivery_time",
    ];
    const csv = [
      fields.join(","),
      ...logs.map((log) =>
        fields
          .map(
            (field) => `"${(log[field] || "").toString().replace(/"/g, '""')}"`
          )
          .join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="campaign-${campaignId}.csv"`
    );
    res.send(csv);
  } catch (error) {
    console.error("Error exporting campaign data:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to export campaign data" });
  }
});

router.post("/del_campaign", validateUser, async (req, res) => {
  try {
    const { id } = req.body;
    await query(`DELETE FROM beta_campaign WHERE campaign_id = ? AND uid = ?`, [
      id,
      req.decode.uid,
    ]);
    await query(
      `DELETE FROM beta_campaign_logs WHERE campaign_id = ? AND uid = ?`,
      [id, req.decode.uid]
    );

    res.json({ msg: "Campaign was deleted", success: true });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

module.exports = router;
