const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const bcrypt = require("bcrypt");
const {
  isValidEmail,
  getFileExtension,
  writeJsonToFile,
  deleteFileIfExists,
  readJsonFromFile,
  makeRequestBeta,
  executeMySQLQuery,
} = require("../functions/function.js");
const { sign } = require("jsonwebtoken");
const validateUser = require("../middlewares/user.js");
const { checkPlan } = require("../middlewares/plan.js");

router.post("/add_new", validateUser, checkPlan, async (req, res) => {
  try {
    const { title, nodes, edges, flowId } = req.body;
    if (!title) {
      return req.json({
        success: false,
        msg: "Please give a title to the flow",
      });
    }

    if (!nodes || !edges || !flowId) {
      return res.json({ success: false, msg: "Nodes and Edges are required" });
    }

    // checking existing
    const checkExisted = await query(`SELECT * FROM flow WHERE flow_id = ?`, [
      flowId,
    ]);

    const nodepath = `${__dirname}/../flow-json/nodes/${req.decode.uid}/${flowId}.json`;
    const edgepath = `${__dirname}/../flow-json/edges/${req.decode.uid}/${flowId}.json`;

    await writeJsonToFile(nodepath, nodes);
    await writeJsonToFile(edgepath, edges);

    if (checkExisted.length > 0) {
      await query(`UPDATE flow SEt title = ? WHERE flow_id = ?`, [
        title,
        flowId,
      ]);
    } else {
      await query(`INSERT INTO flow (uid, flow_id, title) VALUES (?,?,?)`, [
        req.decode.uid,
        flowId,
        title,
      ]);
    }

    res.json({ success: true, msg: "Flow was saved" });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

const validateLastNode = (nodes, edges) => {
  // Find all target nodes (nodes that have incoming connections)
  const targetNodeIds = new Set(edges.map((edge) => edge.target));

  // Find source nodes that aren't targets (potential starting nodes)
  const startingNodes = nodes.filter((node) => !targetNodeIds.has(node.id));

  // If no edges exist, just check the last node in array
  if (edges.length === 0) {
    const lastNode = nodes[nodes.length - 1];
    if (lastNode?.data?.moveToNextNode) {
      return {
        isValid: false,
        message: `${lastNode?.type} Node cannot be last.`,
      };
    }
    return { isValid: true };
  }

  // Traverse the flow to find the actual last connected node
  let lastConnectedNode = null;
  const visited = new Set();

  const traverse = (currentNodeId) => {
    if (visited.has(currentNodeId)) return;
    visited.add(currentNodeId);

    const outgoingEdges = edges.filter((edge) => edge.source === currentNodeId);
    if (outgoingEdges.length === 0) {
      const node = nodes.find((n) => n.id === currentNodeId);
      if (
        node &&
        (!lastConnectedNode || node.position.x > lastConnectedNode.position.x)
      ) {
        lastConnectedNode = node;
      }
      return;
    }

    outgoingEdges.forEach((edge) => {
      traverse(edge.target);
    });
  };

  // Start traversal from all starting nodes
  startingNodes.forEach((node) => traverse(node.id));

  if (lastConnectedNode?.data?.moveToNextNode) {
    return {
      isValid: false,
      message: `${lastConnectedNode?.type} Node cannot be last in the flow.`,
    };
  }

  return { isValid: true };
};

// add new beta
router.post("/insert_flow_beta", validateUser, checkPlan, async (req, res) => {
  try {
    const { name, flow_id, data, source } = req.body;
    if (!name && !flow_id) {
      return res.json({ msg: "Please type a flow name" });
    }

    const nodesVar = data?.nodes || [];

    const validation = validateLastNode(nodesVar, data?.edges);
    if (!validation.isValid) {
      return res.json({ msg: validation.message });
    }

    const sourceTypes = ["wa_chatbot", "webhook_flow"];

    if (!sourceTypes.includes(source)) {
      return res.json({ msg: "Unknown flow source found" });
    }

    if (data?.nodes?.length < 1 || data?.edges?.length < 1) {
      return res.json({ msg: "Blank flow can ot be saved" });
    }

    // checking with the same id
    const [cehckId] = await query(
      `SELECT * FROM beta_flows WHERE flow_id = ?`,
      [flow_id]
    );
    if (cehckId) {
      await query(
        `UPDATE beta_flows SET name = ?, data = ?, source = ? WHERE flow_id = ?`,
        [name, JSON.stringify(data), source, flow_id]
      );

      res.json({ msg: "Flows was updated", success: true });
    } else {
      await query(
        `INSERT INTO beta_flows (uid, flow_id, source, name, data) VALUES (?,?,?,?,?)`,
        [req.decode.uid, flow_id, source, name, JSON.stringify(data)]
      );

      res.json({ msg: "Flows was saved", success: true });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// get flows beta
router.get("/get_flows_beta", validateUser, checkPlan, async (req, res) => {
  try {
    const { type } = req.query;

    let data = await query(
      `SELECT * FROM beta_flows WHERE uid = ? AND source = ?`,
      [req.decode.uid, type]
    );
    data = data.map((x) => {
      return {
        ...x,
        data: JSON.parse(x.data),
      };
    });

    res.json({ data, success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// del flow beta
router.post("/del_flow_beta", validateUser, async (req, res) => {
  try {
    const { id } = req.body;
    await query(`DELETE FROM beta_flows WHERE id = ? AND uid = ?`, [
      id,
      req.decode.uid,
    ]);
    res.json({ msg: "Flow was deleted", success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// get my flows
router.get("/get_mine", validateUser, async (req, res) => {
  try {
    const data = await query(`SELECT * FROM flow WHERE uid = ?`, [
      req.decode.uid,
    ]);
    res.json({ data, success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// del a flow
router.post("/del_flow", validateUser, async (req, res) => {
  try {
    const { id, flowId } = req.body;

    await query(`DELETE FROM flow WHERE uid = ? AND id = ?`, [
      req.decode.uid,
      id,
    ]);

    const nodePath = `${__dirname}/../flow-json/nodes/${req.decode.uid}/${flowId}.json`;
    const edgePath = `${__dirname}/../flow-json/edges/${req.decode.uid}/${flowId}.json`;

    deleteFileIfExists(nodePath);
    deleteFileIfExists(edgePath);

    res.json({ success: true, msg: "Flow was deleted" });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// get flow using flow id
router.post("/get_by_flow_id", validateUser, async (req, res) => {
  try {
    const { flowId } = req.body;

    if (!flowId) {
      return res.json({ success: false, msg: "Flow id missing" });
    }

    const nodePath = `${__dirname}/../flow-json/nodes/${req.decode.uid}/${flowId}.json`;
    const edgePath = `${__dirname}/../flow-json/edges/${req.decode.uid}/${flowId}.json`;

    const nodes = readJsonFromFile(nodePath);
    const edges = readJsonFromFile(edgePath);

    res.json({ nodes, edges, success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});
// get chats activity
router.post("/get_activity", validateUser, checkPlan, async (req, res) => {
  try {
    const { flowId } = req.body;

    const getFlow = await query(
      `SELECT * FROM flow WHERE uid = ? AND flow_id = ?`,
      [req.decode.uid, flowId]
    );

    // Parse prevent and ai lists from the database
    const prevent = getFlow[0]?.prevent_list
      ? JSON.parse(getFlow[0]?.prevent_list)
      : [];
    const ai = getFlow[0]?.ai_list ? JSON.parse(getFlow[0]?.ai_list) : [];

    // Assign unique IDs to each item in the prevent and ai lists
    const preventWithIds = prevent.map((item, index) => ({
      ...item,
      id: `prevent-${index}`, // Assign a unique ID using the index
    }));
    const aiWithIds = ai.map((item, index) => ({
      ...item,
      id: `ai-${index}`, // Assign a unique ID using the index
    }));

    // Log the data with unique IDs
    console.log({
      prevent: preventWithIds,
      ai: aiWithIds,
    });

    // Send the response with lists that have unique IDs
    res.json({ success: true, prevent: preventWithIds, ai: aiWithIds });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// remove number from flow activiy
router.post("/remove_number_from_activity", validateUser, async (req, res) => {
  try {
    const { type, number, flowId } = req.body;

    const [flow] = await query(`SELECT * FROM flow WHERE flow_id = ?`, [
      flowId,
    ]);

    if (type == "AI") {
      // removing from ai arr
      const aiArr = flow?.ai_list ? JSON.parse(flow?.ai_list) : [];
      const updatedArr = aiArr?.filter((x) => x.senderNumber !== number);

      await query(`UPDATE flow SET ai_list = ? WHERE flow_id = ?`, [
        JSON.stringify(updatedArr),
        flowId,
      ]);
    } else if (type == "DISABLED") {
      // removing from prevent arr
      const preventArr = flow?.prevent_list
        ? JSON.parse(flow?.prevent_list)
        : [];
      const updatedPreventArr = preventArr?.filter(
        (x) => x.senderNumber !== number
      );

      await query(`UPDATE flow SET prevent_list = ? WHERE flow_id = ?`, [
        JSON.stringify(updatedPreventArr),
        flowId,
      ]);
    }

    res.json({ msg: "Number was removed", success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// get beta flow sessiosn
router.post("/get_beta_flow_sessions", validateUser, async (req, res) => {
  try {
    const { flow_id } = req.body;
    const data = await query(
      `SELECT * FROM flow_session WHERE uid = ? AND flow_id = ?`,
      [req.decode.uid, flow_id]
    );

    res.json({ data, success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// del flow session
router.post("/del_flow_sess", validateUser, async (req, res) => {
  try {
    const { id } = req.body;
    await query(`DELETE FROM flow_session WHERE id = ? AND uid = ?`, [
      id,
      req.decode.uid,
    ]);
    res.json({ msg: "Session was deleted", success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// reset disabled chat
router.post("/reset_dc_sess", validateUser, async (req, res) => {
  try {
    const { id } = req.body;
    const [getSess] = await query(
      `SELECT * FROM flow_session WHERE id = ? AND uid = ?`,
      [id, req.decode.uid]
    );

    if (getSess) {
      let a = JSON.parse(getSess.data);
      delete a.disableChat;
      await query(`UPDATE flow_session SET data = ? WHERE id = ?`, [
        JSON.stringify(a),
        id,
      ]);
    }

    res.json({ msg: "Disable chat was reset", success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    console.log(err);
  }
});

// Delete multiple flow sessions
router.post("/del_multiple_flow_sess", validateUser, async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.json({ success: false, msg: "No sessions selected" });
    }

    // Create placeholders for the SQL query
    const placeholders = ids.map(() => "?").join(",");

    await query(
      `DELETE FROM flow_session WHERE id IN (${placeholders}) AND uid = ?`,
      [...ids, req.decode.uid]
    );

    res.json({ msg: "Selected sessions were deleted", success: true });
  } catch (err) {
    res.json({ success: false, msg: "Something went wrong" });
    console.log(err);
  }
});

// make request beta
router.post("/make_request_try_beta", validateUser, async (req, res) => {
  try {
    const { data } = req.body;
    const vars = {
      name: "John Doe",
    };
    const resp = await makeRequestBeta(data, vars);

    if (resp.success) {
      console.log({ data: resp.data.body.name });
      res.json({ success: true, msg: "Done" });
    } else {
      res.json({ success: false, msg: resp.msg });
    }
  } catch (err) {
    res.json({ success: false, msg: "Something went wrong" });
    console.log(err);
  }
});

// try mysql con
router.post("/try_con", validateUser, async (req, res) => {
  try {
    const { data } = req.body;
    const respp = await executeMySQLQuery(data);
    if (respp?.success) {
      return res.json({
        success: true,
        msg: "Connection successful",
        data: respp?.data,
      });
    }
    res.json({ success: false, msg: respp?.error || "Connection failed" });
  } catch (err) {
    res.json({ success: false, msg: "Something went wrong" });
    console.log(err);
  }
});

module.exports = router;
