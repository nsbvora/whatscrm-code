const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const bcrypt = require("bcrypt");
const {
  isValidEmail,
  getFileExtension,
  makeRequest,
  readJsonFromFile,
} = require("../functions/function.js");
const { sign } = require("jsonwebtoken");
const validateUser = require("../middlewares/user.js");
const { checkPlan } = require("../middlewares/plan.js");

function hasPropertyWithValue(arr, property, value) {
  return arr.some((item) => item[property] === value);
}

router.post("/add_chatbot", validateUser, checkPlan, async (req, res) => {
  try {
    const { title, chats, flow, for_all, origin: originRaw = {} } = req.body;

    const origin = {
      title: "Meta",
      code: "META",
      data: {},
      ...originRaw,
    };

    if (req.plan?.allow_chatbot < 1) {
      return res.json({
        success: false,
        msg: "Your plan does not allow you to set a chatbot",
      });
    }

    if (!origin?.code) {
      return res.json({ msg: "Please select a chatbot Origin" });
    }

    if (!title || chats.length < 1 || !flow) {
      return res.json({
        success: false,
        msg: "Please provide the all fields! title, chats, flow are required",
      });
    }

    // checking for qr chatbot if they used a flow which contain interactive buttons
    if (origin?.code !== "META") {
      const flowPath = `${__dirname}/../flow-json/nodes/${req.decode.uid}/${flow?.flow_id}.json`;
      const nodeData = readJsonFromFile(flowPath);
      const checkBtn = hasPropertyWithValue(nodeData, "type", "BUTTON");
      const checkList = hasPropertyWithValue(nodeData, "type", "LIST");
      if (checkBtn || checkList) {
        return res.json({
          msg: "Please select another flow which does not contain interactive buttons",
        });
      }
    }

    await query(
      `INSERT INTO chatbot (uid, title, for_all, chats, flow, flow_id, active, origin) VALUES (?,?,?,?,?,?,?,?)`,
      [
        req.decode.uid,
        title,
        for_all ? 1 : 0,
        JSON.stringify(chats),
        JSON.stringify(flow),
        flow?.id,
        1,
        JSON.stringify(origin),
      ]
    );

    res.json({ success: true, msg: "Chatbot was added" });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// update chatbot
router.post("/update_chatbot", validateUser, checkPlan, async (req, res) => {
  try {
    const {
      title,
      chats,
      flow,
      for_all,
      id,
      origin: originRaw = {},
    } = req.body;

    const origin = {
      title: "Meta",
      code: "META",
      data: {},
      ...originRaw,
    };

    if (req.plan?.allow_chatbot < 1) {
      return res.json({
        success: false,
        msg: "Your plan does not allow you to set a chatbot",
      });
    }

    if (!title || chats.length < 1 || !flow) {
      return res.json({
        success: false,
        msg: "Please provide the all fields! title, chats, flow are required",
      });
    }

    if (!origin?.code) {
      return res.json({ msg: "Please select a chatbot Origin" });
    }

    // checking for qr chatbot if they used a flow which contain interactive buttons
    if (origin?.code !== "META") {
      const flowPath = `${__dirname}/../flow-json/nodes/${req.decode.uid}/${flow?.flow_id}.json`;
      const nodeData = readJsonFromFile(flowPath);
      const checkBtn = hasPropertyWithValue(nodeData, "type", "BUTTON");
      const checkList = hasPropertyWithValue(nodeData, "type", "LIST");
      if (checkBtn || checkList) {
        return res.json({
          msg: "Please select another flow which does not contain interactive buttons",
        });
      }
    }

    await query(
      `UPDATE chatbot SET title = ?, for_all = ?, chats = ?, flow = ?, flow_id = ?, origin = ? WHERE id = ?`,
      [
        title,
        for_all ? 1 : 0,
        JSON.stringify(chats),
        JSON.stringify(flow),
        flow?.id,
        JSON.stringify(origin),
        id,
      ]
    );

    res.json({ success: true, msg: "Chatbot was updated" });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// get my chatbots
router.get("/get_chatbot", validateUser, async (req, res) => {
  try {
    const data = await query(`SELECT * FROM chatbot WHERE uid = ?`, [
      req.decode.uid,
    ]);
    res.json({ data, success: true });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// change bot status
router.post("/change_bot_status", validateUser, checkPlan, async (req, res) => {
  try {
    const { id, status } = req.body;

    if (req.plan?.allow_chatbot < 1) {
      return res.json({
        success: false,
        msg: "Your plan does not allow you to set a chatbot",
      });
    }

    await query(`UPDATE chatbot SET active = ? WHERE uid = ? AND id = ?`, [
      status ? 1 : 0,
      req.decode.uid,
      id,
    ]);

    res.json({ success: true, msg: "Chatbot was updated" });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// del chatbot
router.post("/del_chatbot", validateUser, async (req, res) => {
  try {
    const { id } = req.body;
    await query(`DELETE FROM chatbot WHERE id = ? AND uid = ?`, [
      id,
      req.decode.uid,
    ]);
    res.json({ success: true, msg: "Chatbot was deleted" });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// try to make a request
router.post("/make_request_api", validateUser, checkPlan, async (req, res) => {
  try {
    const { url, body, headers, type } = req.body;

    if (!url || !type) {
      return res.json({ msg: "Url is required" });
    }

    const resp = await makeRequest({
      method: type,
      url,
      body,
      headers,
    });

    res.json(resp);
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

router.post("/add_beta_chatbot", validateUser, checkPlan, async (req, res) => {
  try {
    const { title, origin, flow } = req.body;
    if (!title || !origin || !flow?.id) {
      return res.json({ msg: "Please fill all required fields" });
    }

    if (req.plan?.allow_chatbot < 1) {
      return res.json({
        success: false,
        msg: "Your plan does not allow you to set a chatbot",
      });
    }

    const { flow_id } = flow;
    const [getFlow] = await query(
      `SELECT * FROM beta_flows WHERE flow_id = ? AND uid = ?`,
      [flow_id, req.decode.uid]
    );
    if (!getFlow) {
      return res.json({ msg: "This flow is not existed" });
    }

    const flowNodesEdges = getFlow?.data ? JSON.parse(getFlow.data) : null;

    if (!flowNodesEdges || flowNodesEdges?.nodes?.length < 2) {
      return res.json({
        msg: "This flow does not have enough nodes to start, Please complete the flow",
      });
    }

    const { nodes, edges } = flowNodesEdges;

    if (origin?.code !== "META") {
      const checkBtn = hasPropertyWithValue(nodes, "type", "BUTTON");
      const checkList = hasPropertyWithValue(nodes, "type", "LIST");
      if (checkBtn || checkList) {
        return res.json({
          msg: "Please select another flow which does not contain interactive buttons",
        });
      }
    }

    const origins = ["QR", "META"];
    if (!origins.includes(origin.code)) {
      return res.json({ msg: "Please select the origin" });
    }

    const getAllChatbots = await query(
      `SELECT * FROM beta_chatbot WHERE uid = ?`,
      [req.decode.uid]
    );

    // Assuming the chatbot data is stored as JSON in the database
    const chatbots = getAllChatbots?.map((x) => JSON.parse(x.origin)) || [];

    if (chatbots.find((x) => x.code === "META")) {
      return res.json({
        msg: "A chatbot is already running for this device, Please delete that to add new",
      });
    }

    if (chatbots.find((x) => x.title === origin?.title)) {
      return res.json({
        msg: "A chatbot with this title already exists for this device",
      });
    }

    if (origin.code === "QR" && !origin.data?.uniqueId) {
      return res.json({ msg: "No active account found using this origin" });
    }

    await query(
      `INSERT INTO beta_chatbot (uid, title, flow_id, origin, origin_id) VALUES (?,?,?,?,?)`,
      [
        req.decode.uid,
        title,
        flow_id,
        JSON.stringify(origin),
        origin.code === "META" ? "META" : origin.data?.uniqueId,
      ]
    );

    res.json({ success: true, msg: "Chatbot was added" });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// get all chatbots beta
router.get("/get_beta_chatbots", validateUser, async (req, res) => {
  try {
    const { type } = req.query;
    const data = await query(
      `SELECT * FROM beta_chatbot WHERE uid = ? AND source = ?`,
      [req.decode.uid, type]
    );
    res.json({ data, success: true });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// change bot status
router.post("/change_beta_bot_status", validateUser, async (req, res) => {
  try {
    const { id, status } = req.body;
    await query(`UPDATE beta_chatbot SET active = ? WHERE uid = ? AND id = ?`, [
      status ? 1 : 0,
      req.decode.uid,
      id,
    ]);
    res.json({ msg: "Satus changed", success: true });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

// del beta chatbot
router.post("/del_beta_chatbot", validateUser, async (req, res) => {
  try {
    const { id } = req.body;
    await query(`DELETE FROM beta_chatbot WHERE id = ? AND uid = ?`, [
      id,
      req.decode.uid,
    ]);
    res.json({ msg: "Chatbot was deleted", success: true });
  } catch (err) {
    console.log(err);
    res.json({ success: false, msg: "Something went wrong", err });
  }
});

module.exports = router;
