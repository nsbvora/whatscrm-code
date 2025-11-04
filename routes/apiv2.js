const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const bcrypt = require("bcrypt");
const {
  getUserPlayDays,
  sendAPIMessage,
  getNumberOfDaysFromTimestamp,
  sendMetatemplet,
} = require("../functions/function.js");
const { sign } = require("jsonwebtoken");
const validateUser = require("../middlewares/user.js");
const Stripe = require("stripe");
const {
  checkPlan,
  checkNote,
  checkTags,
  checkContactLimit,
} = require("../middlewares/plan.js");
const { recoverEmail } = require("../emails/returnEmails.js");
const moment = require("moment");
const jwt = require("jsonwebtoken");
const { getMetaTempletByName } = require("../loops/loopFunctions.js");

function decodeToken(token) {
  return new Promise((resolve) => {
    jwt.verify(token, process.env.JWTKEY, async (err, decode) => {
      if (err) {
        return resolve({
          success: false,
          data: {},
          message: "Invalid API keys",
        });
      }
      const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [
        decode?.uid,
      ]);
      if (getUser.length < 1) {
        return resolve({
          success: false,
          data: {},
          message: "Invalid API keys",
        });
      }

      if (getUser[0]?.api_key !== token) {
        return res.json({ success: false, msg: "Token was expired." });
      } else {
        resolve({
          success: true,
          data: getUser[0],
        });
      }
    });
  });
}

router.post("/send-message", async (req, res) => {
  try {
    const { token } = req.query;
    const { messageObject } = req.body;

    if (!token) {
      return res.json({ success: false, message: "API keys not found" });
    }

    const checkToken = await decodeToken(token);

    if (!checkToken.success) {
      return res.json({ success: false, message: "Invalid API keys found" });
    }

    const user = checkToken.data;

    if (!user.plan || !user?.plan_expire) {
      return res.json({
        success: false,
        message: "Your dont have any plan please buy one.",
      });
    }

    const getDays = getNumberOfDaysFromTimestamp(user?.plan_expire);

    if (getDays < 1) {
      return res.json({
        success: false,
        message: "Your plan was expired please renew your plan.",
      });
    }

    // checking api eligibility
    const plan = JSON.parse(user?.plan);

    if (plan?.allow_api < 1) {
      return res.json({
        success: false,
        message:
          "Your plan does not allow you to use API feature. Please get another plan",
      });
    }

    if (!messageObject) {
      return res.json({
        success: false,
        message: "messageObject key is required as body response.",
      });
    }

    const getMetaApi = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      user?.uid,
    ]);
    if (getMetaApi.length < 1) {
      return res.json({
        success: false,
        message: "Please provide your META API keys in the profile section",
      });
    }

    const waToken = getMetaApi[0]?.access_token;
    const waNumId = getMetaApi[0]?.business_phone_number_id;

    if (!waToken || !waNumId) {
      return res.json({
        success: false,
        message: "Please provide your META API keys in the profile section",
      });
    }

    const sendMsg = await sendAPIMessage(messageObject, waNumId, waToken);

    res.json(sendMsg);
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// send templet
router.post("/send_templet", async (req, res) => {
  try {
    let dynamicMedia;
    const { sendTo, templetName, exampleArr, token, mediaUri } = req.body;

    // checking plan
    if (!token) {
      return res.json({ success: false, message: "API keys not found" });
    }

    const checkToken = await decodeToken(token);

    if (!checkToken.success) {
      return res.json({ success: false, message: "Invalid API keys found" });
    }

    const user = checkToken.data;

    if (!user.plan || !user?.plan_expire) {
      return res.json({
        success: false,
        message: "Your dont have any plan please buy one.",
      });
    }

    const getDays = getNumberOfDaysFromTimestamp(user?.plan_expire);

    if (getDays < 1) {
      return res.json({
        success: false,
        message: "Your plan was expired please renew your plan.",
      });
    }

    console.log("1");

    // checking api eligibility
    const plan = JSON.parse(user?.plan);

    if (plan?.allow_api < 1) {
      return res.json({
        success: false,
        message:
          "Your plan does not allow you to use API feature. Please get another plan",
      });
    }
    console.log("2");

    // checking plan end

    // getting user meta keys
    const getMetaApi = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      user?.uid,
    ]);
    if (getMetaApi.length < 1) {
      return res.json({
        success: false,
        message: "Please provide your META API keys in the profile section",
      });
    }

    console.log("3");

    const waToken = getMetaApi[0]?.access_token;
    const waNumId = getMetaApi[0]?.business_phone_number_id;

    if (!waToken || !waNumId) {
      return res.json({
        success: false,
        message: "Please update Api Settings in your user panel",
      });
    }

    console.log("4");

    if (!sendTo) {
      return res.json({
        message: "Please provide `sendTo` key",
        success: false,
      });
    }

    if (!exampleArr) {
      return res.json({
        success: false,
        message: "Please provide exampleArr array",
      });
    }

    if (!templetName) {
      return res.json({
        message: "Please provide `templetName`",
        success: false,
      });
    }

    const templet = await getMetaTempletByName(templetName, getMetaApi[0]);

    console.log("5");

    if (templet.error || templet?.data?.length < 1) {
      return res.json({
        success: false,
        message: templet.error?.message || "Unable to fetch templet from meta",
        metaResponse: templet,
        token,
        waToken,
      });
    }

    console.log({ mediaUri });

    if (mediaUri) {
      dynamicMedia = mediaUri;
    } else {
      dynamicMedia = null;
    }

    console.log({ dynamicMedia });

    const resp = await sendMetatemplet(
      sendTo?.replace("+", ""),
      waNumId,
      waToken,
      templet?.data[0],
      exampleArr,
      dynamicMedia
    );

    console.log("6");

    if (resp.error) {
      res.json({
        success: false,
        metaResponse: resp,
      });
    } else {
      res.json({
        success: true,
        metaResponse: resp,
      });
    }
  } catch (err) {
    console.log(err);
    res.json({
      err: err?.toString(),
      success: false,
      msg: "Something went wrong",
    });
  }
});

module.exports = router;
