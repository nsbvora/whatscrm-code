const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const bcrypt = require("bcrypt");
const {
  isValidEmail,
  getFileExtension,
  getBusinessPhoneNumber,
  createMetaTemplet,
  getAllTempletsMeta,
  delMetaTemplet,
  getFileInfo,
  getSessionUploadMediaMeta,
  uploadFileMeta,
  updateUserPlan,
  getUserOrderssByMonth,
  sendEmail,
  fetchProfileFun,
  returnWidget,
  generateWhatsAppURL,
  rzCapturePayment,
  validateFacebookToken,
  getAllTempletsMetaBeta,
  extractTemplateVariablesBeta,
  formatPhoneNumber,
  sendTemplateMessage,
} = require("../functions/function.js");
const { sign } = require("jsonwebtoken");
const validateUser = require("../middlewares/user.js");
const Stripe = require("stripe");
const {
  checkPlan,
  checkNote,
  checkTags,
  checkContactLimit,
  checkWaWArmer,
} = require("../middlewares/plan.js");
const { recoverEmail } = require("../emails/returnEmails.js");
const moment = require("moment");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const { checkQr } = require("../helper/addon/qr/index.js");
const { addON } = require("../env.js");

// facebook login
router.post("/login_with_facebook", async (req, res) => {
  try {
    const { token, userId, email, name } = req.body;

    if (!token || !userId || !email || !name) {
      return res.json({
        msg: "Login can not be completed, Input not provided",
      });
    }

    // getting app id and secrect
    const [getWeb] = await query(`SELECT * FROM web_public`, []);
    const appId = getWeb?.fb_login_app_id;
    const appSec = getWeb?.fb_login_app_sec;

    if (!appId || !appSec) {
      return res.json({
        msg: "Please fill the app ID and secrect from the admin panel to complete facebook login",
      });
    }

    const checkToken = await validateFacebookToken(token, appId, appSec);
    if (!checkToken?.success) {
      return res.json({
        msg: "Can not complete your facebook login some perameteres could not match",
      });
    }

    const resp = checkToken?.response?.data;

    console.log({ resp: JSON.stringify(checkToken) });

    const decodedUserId = resp?.user_id;

    if (decodedUserId == userId && resp?.is_valid) {
      const getUser = await query(`SELECT * FROM user WHERE email = ?`, [
        email,
      ]);

      if (getUser?.length < 1) {
        const uid = randomstring.generate();
        const password = userId;
        const hasPass = await bcrypt.hash(password, 10);
        await query(
          `INSERT INTO user (name, uid, email, password) VALUES (?,?,?,?)`,
          [name, uid, email, hasPass]
        );

        const loginToken = sign(
          {
            uid: uid,
            role: "user",
            password: hasPass,
            email: email,
          },
          process.env.JWTKEY,
          {}
        );

        res.json({ token: loginToken, success: true });
      } else {
        const loginToken = sign(
          {
            uid: getUser[0].uid,
            role: "user",
            password: getUser[0].password,
            email: getUser[0].email,
          },
          process.env.JWTKEY,
          {}
        );
        res.json({
          success: true,
          token: loginToken,
        });
      }
    } else {
      res.json({ msg: "The login token found invalid" });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// google login
router.post("/login_with_google", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.json({ msg: "Please check your token its not valid" });
    }

    const decoded = jwt.decode(token, { complete: true });

    if (decoded?.payload?.email && decoded?.payload?.email_verified) {
      const email = decoded?.payload?.email;
      const name = decoded?.payload?.name;

      const getUser = await query(`SELECT * FROM user WHERE email = ?`, [
        email,
      ]);
      if (getUser?.length < 1) {
        const uid = randomstring.generate();
        const password = decoded.header?.kid;
        const hasPass = await bcrypt.hash(password, 10);
        await query(
          `INSERT INTO user (name, uid, email, password) VALUES (?,?,?,?)`,
          [name, uid, email, hasPass]
        );

        const loginToken = sign(
          {
            uid: uid,
            role: "user",
            password: hasPass,
            email: email,
          },
          process.env.JWTKEY,
          {}
        );

        res.json({ token: loginToken, success: true });
      } else {
        const loginToken = sign(
          {
            uid: getUser[0].uid,
            role: "user",
            password: getUser[0].password,
            email: getUser[0].email,
          },
          process.env.JWTKEY,
          {}
        );
        res.json({
          success: true,
          token: loginToken,
        });
      }
    } else {
      res.json({
        success: false,
        msg: "Count not complete google login",
      });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// aignup user
router.post("/signup", async (req, res) => {
  try {
    const { email, name, password, mobile_with_country_code, acceptPolicy } =
      req.body;

    if (!email || !name || !password || !mobile_with_country_code) {
      return res.json({ msg: "Please fill the details", success: false });
    }

    if (!acceptPolicy) {
      return res.json({
        msg: "You did not click on checkbox of Privacy & Terms",
        success: false,
      });
    }

    if (!isValidEmail(email)) {
      return res.json({ msg: "Please enter a valid email", success: false });
    }

    // check if user already has same email
    const findEx = await query(`SELECT * FROM user WHERE email = ?`, email);
    if (findEx.length > 0) {
      return res.json({ msg: "A user already exist with this email" });
    }

    const haspass = await bcrypt.hash(password, 10);
    const uid = randomstring.generate();

    await query(
      `INSERT INTO user (name, uid, email, password, mobile_with_country_code) VALUES (?,?,?,?,?)`,
      [name, uid, email, haspass, mobile_with_country_code]
    );

    res.json({ msg: "Signup Success", success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// login user
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.json({
        success: false,
        msg: "Please provide email and password",
      });
    }

    // check for user
    const userFind = await query(`SELECT * FROM user WHERE email = ?`, [email]);
    if (userFind.length < 1) {
      return res.json({ msg: "Invalid credentials" });
    }

    const compare = await bcrypt.compare(password, userFind[0].password);

    if (!compare) {
      return res.json({ msg: "Invalid credentials" });
    } else {
      const token = sign(
        {
          uid: userFind[0].uid,
          role: "user",
          password: userFind[0].password,
          email: userFind[0].email,
        },
        process.env.JWTKEY,
        {}
      );
      res.json({
        success: true,
        token,
      });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// return image url
router.post("/return_media_url", validateUser, async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.json({ success: false, msg: "No files were uploaded" });
    }

    const randomString = randomstring.generate();
    const file = req.files.file;

    const filename = `${randomString}.${getFileExtension(file.name)}`;

    file.mv(`${__dirname}/../client/public/media/${filename}`, (err) => {
      if (err) {
        console.log(err);
        return res.json({ err });
      }
    });

    const url = `${process.env.FRONTENDURI}/media/${filename}`;
    res.json({ success: true, url });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// get user
router.get("/get_me", validateUser, async (req, res) => {
  try {
    const data = await query(`SELECT * FROM user WHERE uid = ?`, [
      req.decode.uid,
    ]);

    const qrCheck = checkQr();
    const finalAddon = qrCheck ? [...addON, "QR"] : addON;

    // getting phonebook
    const contact = await query(`SELECT * FROM contact WHERE uid = ?`, [
      req.decode.uid,
    ]);

    res.json({
      data: { ...data[0], contact: contact.length },
      success: true,
      addon: finalAddon,
    });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// update notes
router.post(
  "/save_note",
  validateUser,
  checkPlan,
  checkNote,
  async (req, res) => {
    try {
      const { chatId, note } = req.body;

      await query(`UPDATE chats SET chat_note = ? WHERE chat_id = ?`, [
        note,
        chatId,
      ]);
      res.json({ success: true, msg: "Notes were updated" });
    } catch (err) {
      res.json({ success: false, msg: "something went wrong", err });
      console.log(err);
    }
  }
);

// update tags
router.post(
  "/push_tag",
  validateUser,
  checkPlan,
  checkTags,
  async (req, res) => {
    try {
      const { tag, chatId } = req.body;

      if (!tag) {
        return res.json({ success: false, msg: "Please type a tag" });
      }

      const getChat = await query(`SELECT * FROM chats WHERE chat_id = ?`, [
        chatId,
      ]);

      if (getChat.length < 1) {
        return res.json({ success: false, msg: "Chat not found" });
      }
      const getTags = getChat[0]?.chat_tags
        ? JSON.parse(getChat[0]?.chat_tags)
        : [];
      const addNew = [...getTags, tag];

      await query(`UPDATE chats SET chat_tags = ? WHERE chat_id = ?`, [
        JSON.stringify(addNew),
        chatId,
      ]);

      res.json({ success: true, msg: "Tag was added" });
    } catch (err) {
      res.json({ success: false, msg: "something went wrong", err });
      console.log(err);
    }
  }
);

// del a tag
router.post("/del_tag", validateUser, async (req, res) => {
  try {
    const { tag, chatId } = req.body;

    const getAll = await query(`SELECT * FROM chats WHERE chat_id = ?`, [
      chatId,
    ]);
    if (getAll.length < 1) {
      return res.json({ success: false, msg: "Chat not found" });
    }

    const getAllTags = getAll[0]?.chat_tags
      ? JSON.parse(getAll[0]?.chat_tags)
      : [];

    const newOne = getAllTags?.filter((i) => i !== tag);

    console.log({ newOne });

    await query(`UPDATE chats SET chat_tags = ? WHERE chat_id = ?`, [
      JSON.stringify(newOne),
      chatId,
    ]);

    res.json({ success: true, msg: "Tag was deleted" });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// check contact exist
router.post("/check_contact", validateUser, async (req, res) => {
  try {
    const { mobile } = req.body;

    const findFirst = await query(
      `SELECT * FROM contact WHERE mobile = ? AND uid = ? `,
      [mobile, req.decode.uid]
    );
    const getAllPhonebook = await query(
      `SELECT * FROM phonebook WHERE uid = ?`,
      [req.decode.uid]
    );

    if (findFirst.length < 1) {
      return res.json({
        success: false,
        msg: "Contact not found in phonebook",
        phonebook: getAllPhonebook,
      });
    }

    res.json({
      success: true,
      phonebook: getAllPhonebook,
      contact: findFirst[0],
    });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// save the contact
router.post(
  "/save_contact",
  validateUser,
  checkPlan,
  checkContactLimit,
  async (req, res) => {
    try {
      const {
        phoneBookName,
        phoneBookId,
        phoneNumber,
        contactName,
        var1,
        var2,
        var3,
        var4,
        var5,
      } = req.body;

      if (!phoneBookName || !phoneBookId || !phoneNumber || !contactName) {
        return res.json({ success: false, msg: "incomplete input provided" });
      }

      const findExist = await query(
        `SELECT * FROM contact WHERE mobile = ? AND uid = ?`,
        [phoneNumber, req.decode.uid]
      );
      if (findExist.length > 0) {
        return res.json({ success: false, msg: "Contact already existed" });
      }

      await query(
        `INSERT INTO contact (uid, phonebook_id, phonebook_name, name, mobile, var1, var2, var3, var4, var5) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          req.decode.uid,
          phoneBookId,
          phoneBookName,
          contactName,
          phoneNumber,
          var1 || "",
          var2 || "",
          var3 || "",
          var4 || "",
          var5 || "",
        ]
      );

      res.json({ success: true, msg: "Contact was added" });
    } catch (err) {
      res.json({ success: false, msg: "something went wrong", err });
      console.log(err);
    }
  }
);

// del contact
router.post("/del_contact", validateUser, async (req, res) => {
  try {
    const { id } = req.body;
    await query(`DELETE FROM contact WHERE id = ?`, [id]);
    res.json({ success: true, msg: "Contact was deleted" });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

router.post("/update_meta", validateUser, async (req, res) => {
  try {
    const {
      waba_id,
      business_account_id,
      access_token,
      business_phone_number_id,
      app_id,
    } = req.body;

    if (
      !waba_id ||
      !business_account_id ||
      !access_token ||
      !business_account_id ||
      !app_id
    ) {
      return res.json({ success: false, msg: "Please fill all the fields" });
    }

    const resp = await getBusinessPhoneNumber(
      "v18.0",
      business_phone_number_id,
      access_token
    );

    if (resp?.error) {
      return res.json({
        success: false,
        msg: resp?.error?.message || "Please check your details",
      });
    }

    const findOne = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      req.decode.uid,
    ]);
    if (findOne.length > 0) {
      await query(
        `UPDATE meta_api SET waba_id = ?, business_account_id = ?, access_token = ?, business_phone_number_id = ?, app_id = ? WHERE uid = ?`,
        [
          waba_id,
          business_account_id,
          access_token,
          business_phone_number_id,
          app_id,
          req.decode.uid,
        ]
      );
    } else {
      await query(
        `INSERT INTO meta_api (uid, waba_id, business_account_id, access_token, business_phone_number_id, app_id) VALUES (?,?,?,?,?,?)`,
        [
          req.decode.uid,
          waba_id,
          business_account_id,
          access_token,
          business_phone_number_id,
          app_id,
        ]
      );
    }

    res.json({
      success: true,
      msg: "Your meta settings were updated successfully!",
    });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// get meta keys
router.get("/get_meta_keys", validateUser, async (req, res) => {
  try {
    const data = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      req.decode.uid,
    ]);
    if (data.length < 1) {
      res.json({ success: true, data: {} });
    } else {
      res.json({ success: true, data: data[0] });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// add meta templet
router.post("/add_meta_templet", validateUser, checkPlan, async (req, res) => {
  try {
    console.log(JSON.stringify(req.body));

    const getAPIKEYS = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      req.decode.uid,
    ]);

    if (getAPIKEYS.length < 1) {
      return res.json({
        success: false,
        msg: "Please fill your meta API keys",
      });
    }

    const resp = await createMetaTemplet(
      "v18.0",
      getAPIKEYS[0]?.waba_id,
      getAPIKEYS[0]?.access_token,
      req.body
    );

    if (resp.error) {
      res.json({ msg: resp?.error?.error_user_msg || resp?.error?.message });
    } else {
      console.log(resp);
      res.json({
        msg: "Templet was added and waiting for the review",
        success: true,
      });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// get user meta templet
router.get("/get_my_meta_templets", validateUser, async (req, res) => {
  try {
    const getMETA = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      req.decode.uid,
    ]);
    if (getMETA.length < 1) {
      return res.json({
        success: false,
        msg: "Please check your meta API keys",
      });
    }

    const resp = await getAllTempletsMeta(
      "v18.0",
      getMETA[0]?.waba_id,
      getMETA[0]?.access_token
    );

    if (resp?.error) {
      res.json({
        success: false,
        msg: resp?.error?.message || "Please check your API",
      });
    } else {
      res.json({ success: true, data: resp?.data || [] });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// del meta templet
router.post("/del_meta_templet", validateUser, async (req, res) => {
  try {
    const { name } = req.body;

    const getMETA = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      req.decode.uid,
    ]);
    if (getMETA.length < 1) {
      return res.json({
        success: false,
        msg: "Please check your meta API keys",
      });
    }

    const resp = await delMetaTemplet(
      "v18.0",
      getMETA[0]?.waba_id,
      getMETA[0]?.access_token,
      name
    );

    if (resp.error) {
      return res.json({
        success: false,
        msg: resp?.error?.error_user_title || "Please check your API",
      });
    } else {
      res.json({
        success: true,
        data: resp?.data || [],
        msg: "Templet was deleted",
      });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// return meta media url
router.post("/return_media_url_meta", validateUser, async (req, res) => {
  try {
    if (!req.body?.templet_name) {
      return res.json({
        success: false,
        msg: "Please give a templet name first ",
      });
    }

    if (!req.files || Object.keys(req.files).length === 0) {
      return res.json({ success: false, msg: "No files were uploaded" });
    }

    const getMETA = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      req.decode.uid,
    ]);
    if (getMETA.length < 1) {
      return res.json({
        success: false,
        msg: "Please check your meta API keys",
      });
    }

    const randomString = randomstring.generate();
    const file = req.files.file;

    const filename = `${randomString}.${getFileExtension(file.name)}`;

    // Move the file and wait for it to complete
    await new Promise((resolve, reject) => {
      file.mv(`${__dirname}/../client/public/media/${filename}`, (err) => {
        if (err) {
          console.log(err);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    setTimeout(async () => {
      const { fileSizeInBytes, mimeType } = await getFileInfo(
        `${__dirname}/../client/public/media/${filename}`
      );

      const getSession = await getSessionUploadMediaMeta(
        "v18.0",
        getMETA[0]?.app_id,
        getMETA[0]?.access_token,
        fileSizeInBytes,
        mimeType
      );

      const uploadFile = await uploadFileMeta(
        getSession?.id,
        `${__dirname}/../client/public/media/${filename}`,
        "v18.0",
        getMETA[0]?.access_token
      );

      if (!uploadFile?.success) {
        return res.json({ success: false, msg: "Please check your meta API" });
      }

      const url = `${process.env.FRONTENDURI}/media/${filename}`;

      await query(
        `INSERT INTO meta_templet_media (uid, templet_name, meta_hash, file_name) VALUES (?,?,?,?)`,
        [req.decode.uid, req.body?.templet_name, uploadFile?.data?.h, filename]
      );

      res.json({ success: true, url, hash: uploadFile?.data?.h });
    }, 1000);
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// get plan detail
router.post("/get_plan_details", validateUser, async (req, res) => {
  try {
    const { id } = req.body;

    const data = await query(`SELECT * FROM plan WHERE id = ?`, [id]);
    if (data.length < 1) {
      return res.json({ success: false, data: null });
    } else {
      res.json({ success: true, data: data[0] });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// get payment gateway
router.get("/get_payment_details", validateUser, async (req, res) => {
  try {
    const resp = await query(`SELECT * FROM web_private`, []);
    let data = resp[0];
    const [userData] = await query(`SELECT * FROM user WHERE uid = ?`, [
      req.decode.uid,
    ]);

    data.pay_stripe_key = "";
    res.json({ data, userData, success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// creating stripe pay session
router.post("/create_stripe_session", validateUser, async (req, res) => {
  try {
    const getWeb = await query(`SELECT * FROM web_private`, []);

    if (
      getWeb.length < 1 ||
      !getWeb[0]?.pay_stripe_key ||
      !getWeb[0]?.pay_stripe_id
    ) {
      return res.json({
        success: false,
        msg: "Opss.. payment keys found not found",
      });
    }

    const stripeKeys = getWeb[0]?.pay_stripe_key;

    const stripeClient = new Stripe(stripeKeys);

    const { planId } = req.body;

    const plan = await query(`SELECT * FROM plan WHERE id = ?`, [planId]);

    if (plan.length < 1) {
      return res.json({ msg: "No plan found with the id" });
    }

    const randomSt = randomstring.generate();
    const orderID = `STRIPE_${randomSt}`;

    await query(
      `INSERT INTO orders (uid, payment_mode, amount, data) VALUES (?,?,?,?)`,
      [req.decode.uid, "STRIPE", plan[0]?.price, orderID]
    );

    const web = await query(`SELECT * FROM web_public`, []);

    const productStripe = [
      {
        price_data: {
          currency: web[0]?.currency_code,
          product_data: {
            name: plan[0]?.title,
            // images:[product.imgdata]
          },
          unit_amount: plan[0]?.price * 100,
        },
        quantity: 1,
      },
    ];

    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: productStripe,
      mode: "payment",
      success_url: `${process.env.BACKURI}/api/user/stripe_payment?order=${orderID}&plan=${plan[0]?.id}`,
      cancel_url: `${process.env.BACKURI}/api/user/stripe_payment?order=${orderID}&plan=${plan[0]?.id}`,
      locale: process.env.STRIPE_LANG || "en",
    });

    await query(`UPDATE orders SET s_token = ? WHERE data = ?`, [
      session?.id,
      orderID,
    ]);

    res.json({ success: true, session: session });
  } catch (err) {
    res.json({ msg: err.toString(), err });
    console.log({ err, msg: JSON.stringify(err), string: err.toString() });
  }
});

router.post("/pay_with_rz", validateUser, async (req, res) => {
  try {
    const { rz_payment_id, plan, amount } = req.body;
    if (!rz_payment_id || !plan || !amount) {
      return res.json({ msg: "please send required fields" });
    }

    // getting plan
    const getPlan = await query(`SELECT * FROM plan WHERE id = ?`, [plan?.id]);

    if (getPlan.length < 1) {
      return res.json({
        msg: "Invalid plan found",
      });
    }

    // getting private web
    const [webPrivate] = await query(`SELECT * from web_private`, []);
    const [webPublic] = await query(`SELECT * FROM web_public`, []);

    const rzId = webPrivate?.rz_id;
    const rzKeys = webPrivate?.rz_key;

    if (!rzId || !rzKeys) {
      return res.json({
        msg: `Please fill your razorpay credentials! if: ${rzId} keys: ${rzKeys}`,
      });
    }

    const finalamt =
      (parseInt(amount) / parseInt(webPublic.exchange_rate)) * 80;

    const resp = await rzCapturePayment(
      rz_payment_id,
      Math.round(finalamt) * 100,
      rzId,
      rzKeys
    );

    if (!resp) {
      res.json({ success: false, msg: resp.description });
      return;
    }

    await updateUserPlan(getPlan[0], req.decode.uid);

    await query(
      `INSERT INTO orders (uid, payment_mode, amount, data) VALUES (?,?,?,?)`,
      [req.decode.uid, "RAZORPAY", plan?.price, JSON.stringify(resp)]
    );

    res.json({
      success: true,
      msg: "Thank for your payment you are good to go now.",
    });
  } catch (err) {
    res.json({ msg: err.toString(), err });
    console.log({ err, msg: JSON.stringify(err), string: err.toString() });
  }
});

// pay with paypal
router.post("/pay_with_paypal", validateUser, async (req, res) => {
  try {
    const { orderID, plan } = req.body;

    if (!plan || !orderID) {
      return res.json({ msg: "order id and plan required" });
    }

    // getting plan
    const getPlan = await query(`SELECT * FROM plan WHERE id = ?`, [plan?.id]);

    if (getPlan.length < 1) {
      return res.json({
        msg: "Invalid plan found",
      });
    }

    // getting private web
    const [webPrivate] = await query(`SELECT * from web_private`, []);

    const paypalClientId = webPrivate?.pay_paypal_id;
    const paypalClientSecret = webPrivate?.pay_paypal_key;

    if (!paypalClientId || !paypalClientSecret) {
      return res.json({
        msg: "Please provide paypal ID and keys from the Admin",
      });
    }

    let response = await fetch(
      "https://api.sandbox.paypal.com/v1/oauth2/token",
      {
        method: "POST",
        body: "grant_type=client_credentials",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${paypalClientId}:${paypalClientSecret}`,
              "binary"
            ).toString("base64"),
        },
      }
    );

    let data = await response.json();

    let resp_order = await fetch(
      `https://api.sandbox.paypal.com/v1/checkout/orders/${orderID}`,
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + data.access_token,
        },
      }
    );

    let order_details = await resp_order.json();

    if (order_details.status === "COMPLETED") {
      await updateUserPlan(getPlan[0], req.decode.uid);

      await query(
        `INSERT INTO orders (uid, payment_mode, amount, data) VALUES (?,?,?,?)`,
        [req.decode.uid, "PAYPAL", plan?.price, JSON.stringify(order_details)]
      );

      res.json({
        success: true,
        msg: "Thank for your payment you are good to go now.",
      });
    } else {
      res.json({ success: false, msg: "error_description" });
      return;
    }
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

function checlStripePayment(orderId) {
  return new Promise(async (resolve) => {
    try {
      const getStripe = await query(`SELECT * FROM web_private`, []);

      const stripeClient = new Stripe(getStripe[0]?.pay_stripe_key);
      const getPay = await stripeClient.checkout.sessions.retrieve(orderId);

      console.log({ status: getPay?.payment_status });

      if (getPay?.payment_status === "paid") {
        resolve({ success: true, data: getPay });
      } else {
        resolve({ success: false });
      }
    } catch (err) {
      resolve({ success: false, data: {} });
    }
  });
}

function returnHtmlRes(msg) {
  const html = `<!DOCTYPE html>
    <html>
    <head>
      <meta http-equiv="refresh" content="5;url=${process.env.FRONTENDURI}/user">
      <style>
        body {
          font-family: Arial, sans-serif;
          background-color: #f4f4f4;
          text-align: center;
          margin: 0;
          padding: 0;
        }

        .container {
          background-color: #ffffff;
          border: 1px solid #ccc;
          border-radius: 4px;
          box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
          margin: 100px auto;
          padding: 20px;
          width: 300px;
        }

        p {
          font-size: 18px;
          color: #333;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <p>${msg}</p>
      </div>
    </body>
    </html>
    `;
  return html;
}

router.get("/stripe_payment", async (req, res) => {
  try {
    const { order, plan } = req.query;

    if (!order || !plan) {
      return res.send("INVALID REQUEST");
    }

    const getOrder = await query(`SELECT * FROM orders WHERE data = ?`, [
      order || "",
    ]);
    const getPlan = await query(`SELECT * FROM plan WHERE id = ?`, [plan]);

    if (getOrder.length < 1) {
      return res.send("Invalid payment found");
    }

    if (getPlan.length < 1) {
      return res.send("Invalid plan found");
    }

    const checkPayment = await checlStripePayment(getOrder[0]?.s_token);
    console.log({ checkPayment: checkPayment });

    if (checkPayment.success) {
      res.send(returnHtmlRes("Payment Success! Redirecting..."));

      await query(`UPDATE orders SET data = ? WHERE data = ?`, [
        JSON.stringify(checkPayment?.data),
        order,
      ]);

      await updateUserPlan(getPlan[0], getOrder[0]?.uid);
    } else {
      res.send(
        "Payment Failed! If the balance was deducted please contact to the HamWiz support. Redirecting..."
      );
    }
  } catch (err) {
    console.log(err);
    res.json({ msg: "Something went wrong", err, success: false });
  }
});

// pay with paystack
router.post("/pay_with_paystack", validateUser, async (req, res) => {
  try {
    const { planData, trans_id, reference } = req.body;

    if (!planData || !trans_id) {
      return res.json({
        msg: "Order id and plan required",
      });
    }

    // getting plan
    const plan = await query(`SELECT * FROM plan WHERE id = ?`, [planData.id]);

    if (plan.length < 1) {
      return res.json({ msg: "Sorry this plan was not found" });
    }

    // gettings paystack keys
    const getWebPrivate = await query(`SELECT * FROM web_private`, []);
    const paystackSecretKey = getWebPrivate[0]?.pay_paystack_key;
    const paystackId = getWebPrivate[0]?.pay_paystack_id;

    if (!paystackSecretKey || !paystackId) {
      return res.json({ msg: "Paystack credentials not found" });
    }

    var response = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const resp = await response.json();

    if (resp.data?.status !== "success") {
      res.json({ success: false, msg: `${resp.message} - Ref:-${reference}` });
      return;
    }

    await query(
      `INSERT INTO orders (uid, payment_mode, amount, data) VALUES (?,?,?,?)`,
      [req.decode.uid, "PAYSTACK", plan[0]?.price, reference]
    );

    await updateUserPlan(plan[0], req.decode.uid);

    res.json({
      success: true,
      msg: "Payment success! Redirecting...",
    });
  } catch (err) {
    console.log(err);
    res.json({ msg: "Something went wrong", err, success: false });
  }
});

// update profile
router.post("/update_profile", validateUser, async (req, res) => {
  try {
    const { newPassword, name, mobile_with_country_code, email, timezone } =
      req.body;

    if (!name || !mobile_with_country_code || !email || !timezone) {
      return res.json({
        msg: "Name, Mobile, Email, Timezone are required fields",
      });
    }

    if (newPassword) {
      const hash = await bcrypt.hash(newPassword, 10);
      await query(
        `UPDATE user SET name = ?, email = ?, password = ?, mobile_with_country_code = ?, timezone = ? WHERE uid = ?`,
        [name, email, hash, mobile_with_country_code, timezone, req.decode.uid]
      );
    } else {
      await query(
        `UPDATE user SET name = ?, email = ?, mobile_with_country_code = ?, timezone = ? WHERE uid = ?`,
        [name, email, mobile_with_country_code, timezone, req.decode.uid]
      );
    }

    res.json({ success: true, msg: "Profile was updated" });
  } catch (err) {
    console.log(err);
    res.json({ msg: "Something went wrong", err, success: false });
  }
});

// get dashboard
router.get("/get_dashboard_old", validateUser, async (req, res) => {
  try {
    const getOpenChat = await query(
      `SELECT * FROM chats WHERE uid = ? AND chat_status = ?`,
      [req.decode.uid, "open"]
    );
    const getOpenPending = await query(
      `SELECT * FROM chats WHERE uid = ? AND chat_status = ?`,
      [req.decode.uid, "pending"]
    );
    const getOpenResolved = await query(
      `SELECT * FROM chats WHERE uid = ? AND chat_status = ?`,
      [req.decode.uid, "solved"]
    );

    const getActiveChatbots = await query(
      `SELECT * FROM chatbot WHERE active = ? AND uid = ?`,
      [1, req.decode.uid]
    );
    const getDActiveChatbots = await query(
      `SELECT * FROM chatbot WHERE active = ? AND uid = ?`,
      [0, req.decode.uid]
    );

    const opened = getUserOrderssByMonth(getOpenChat);
    const pending = getUserOrderssByMonth(getOpenPending);
    const resolved = getUserOrderssByMonth(getOpenResolved);
    const activeBot = getUserOrderssByMonth(getActiveChatbots);
    const dActiveBot = getUserOrderssByMonth(getDActiveChatbots);

    // get total chats
    const totalChats = await query(`SELECT * FROM chats WHERE uid = ?`, [
      req.decode.uid,
    ]);
    const totalChatbots = await query(`SELECT * FROM chatbot WHERE uid = ?`, [
      req.decode.uid,
    ]);
    const totalContacts = await query(`SELECT * FROM contact WHERE uid = ?`, [
      req.decode.uid,
    ]);
    const totalFlows = await query(`SELECT * FROM flow WHERE uid = ?`, [
      req.decode.uid,
    ]);
    const totalBroadcast = await query(
      `SELECT * FROM broadcast WHERE uid = ?`,
      [req.decode.uid]
    );
    const totalTemplets = await query(`SELECT * FROM templets WHERE uid = ?`, [
      req.decode.uid,
    ]);

    res.json({
      success: true,
      opened,
      pending,
      resolved,
      activeBot,
      dActiveBot,
      totalChats: totalChats.length,
      totalChatbots: totalChatbots?.length,
      totalContacts: totalContacts?.length,
      totalFlows: totalFlows?.length,
      totalBroadcast: totalBroadcast?.length,
      totalTemplets: totalTemplets?.length,
    });
  } catch (err) {
    console.log(err);
    res.json({ msg: "Something went wrong", err, success: false });
  }
});

router.get("/get_dashboard", validateUser, async (req, res) => {
  try {
    const uid = req.decode.uid;

    // 1. User Profile Data
    const user = await query("SELECT * FROM user WHERE uid = ?", [uid]);

    // 2. Statistics
    const [agents, activeChats, completedTasks, activeInstances] =
      await Promise.all([
        query("SELECT COUNT(*) as count FROM agents WHERE owner_uid = ?", [
          uid,
        ]),
        query(
          "SELECT COUNT(*) as count FROM beta_chats WHERE uid = ? AND unread_count > 0",
          [uid]
        ),
        query(
          "SELECT COUNT(*) as count FROM agent_task WHERE owner_uid = ? AND status = 'COMPLETED'",
          [uid]
        ),
        query(
          "SELECT COUNT(*) as count FROM instance WHERE uid = ? AND status = 'ACTIVE'",
          [uid]
        ),
      ]);

    // 3. Recent Conversations (from beta_conversation)
    const recentConversations = await query(
      `
      SELECT c.*, ch.sender_name, ch.sender_mobile, ch.profile 
      FROM beta_conversation c
      JOIN beta_chats ch ON c.chat_id = ch.chat_id
      WHERE c.uid = ?
      ORDER BY c.createdAt DESC 
      LIMIT 5
    `,
      [uid]
    );

    // 4. Unread Messages Summary
    const unreadSummary = await query(
      `
      SELECT origin, COUNT(*) as count 
      FROM beta_chats 
      WHERE uid = ? AND unread_count > 0
      GROUP BY origin
    `,
      [uid]
    );

    // 5. Active Chatbots
    const activeChatbots = await query(
      `
      SELECT title, flow_id 
      FROM beta_chatbot 
      WHERE uid = ? AND active = 1
      LIMIT 3
    `,
      [uid]
    );

    // 6. Performance Metrics (last 7 days)
    const performanceData = await query(
      `
      SELECT 
        DATE(createdAt) as date,
        COUNT(CASE WHEN route = 'INCOMING' THEN 1 END) as incoming,
        COUNT(CASE WHEN route = 'OUTGOING' THEN 1 END) as outgoing
      FROM beta_conversation
      WHERE uid = ? AND createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(createdAt)
      ORDER BY date ASC
    `,
      [uid]
    );

    const data = {
      user: user[0],
      stats: {
        agents: agents[0].count,
        activeChats: activeChats[0].count,
        completedTasks: completedTasks[0].count,
        activeInstances: activeInstances[0].count,
      },
      recentConversations,
      unreadSummary,
      activeChatbots,
      performanceData,
      lastUpdated: new Date().toISOString(),
    };

    res.json({ success: true, data });
  } catch (err) {
    console.error("Dashboard error:", err);
    res
      .status(500)
      .json({ success: false, msg: "Failed to load dashboard data" });
  }
});

// enroll free plan
router.post("/start_free_trial", validateUser, async (req, res) => {
  try {
    const { planId } = req.body;

    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [
      req.decode.uid,
    ]);
    if (getUser[0]?.trial > 0) {
      return res.json({
        success: false,
        msg: "You have already taken Trial once. You can not enroll for trial again.",
      });
    }

    const getPlan = await query(`SELECT * FROM plan WHERE id = ?`, [planId]);
    if (getPlan.length < 1) {
      return res.json({ msg: "Invalid plan found" });
    }

    if (getPlan[0]?.price > 0) {
      return res.json({ msg: "This plan is not a trial plan." });
    }
    await query(
      `INSERT INTO orders (uid, payment_mode, amount, data) VALUES (?,?,?,?)`,
      [req.decode.uid, "OFFLINE", 0, JSON.stringify({ plan: getPlan[0] })]
    );

    await updateUserPlan(getPlan[0], getUser[0]?.uid);

    await query(`UPDATE user SET trial = ? WHERE uid = ?`, [1, req.decode.uid]);

    res.json({
      success: true,
      msg: "Your trial plan has been activated. You are redirecting to the panel...",
    });
  } catch (err) {
    console.log(err);
    res.json({ msg: "Something went wrong", err, success: false });
  }
});

// send recover
router.post("/send_resovery", async (req, res) => {
  try {
    const { email } = req.body;

    if (!isValidEmail(email)) {
      return res.json({ msg: "Please enter a valid email" });
    }

    const checkEmailValid = await query(`SELECT * FROM user WHERE email = ?`, [
      email,
    ]);
    if (checkEmailValid.length < 1) {
      return res.json({
        success: true,
        msg: "We have sent a recovery link if this email is associated with user account.",
      });
    }

    const getWeb = await query(`SELECT * FROM web_public`, []);
    const appName = getWeb[0]?.app_name;

    const jsontoken = sign(
      {
        old_email: email,
        email: email,
        time: moment(new Date()),
        password: checkEmailValid[0]?.password,
        role: "user",
      },
      process.env.JWTKEY,
      {}
    );

    const recpveryUrl = `${process.env.FRONTENDURI}/recovery-user/${jsontoken}`;

    const getHtml = recoverEmail(appName, recpveryUrl);

    // getting smtp
    const smtp = await query(`SELECT * FROM smtp`, []);
    if (
      !smtp[0]?.email ||
      !smtp[0]?.host ||
      !smtp[0]?.port ||
      !smtp[0]?.password ||
      !smtp[0]?.username
    ) {
      return res.json({
        success: false,
        msg: "SMTP connections not found! Unable to send recovery link",
      });
    }

    await sendEmail(
      smtp[0]?.host,
      smtp[0]?.port,
      smtp[0]?.email,
      smtp[0]?.password,
      getHtml,
      `${appName} - Password Recovery`,
      smtp[0]?.email,
      email,
      smtp[0]?.username
    );

    res.json({
      success: true,
      msg: "We have sent your a password recovery link. Please check your email",
    });
  } catch (err) {
    console.log(err);
    res.json({ msg: "Something went wrong", err, success: false });
  }
});

// modify recpvery passwrod
router.get("/modify_password", validateUser, async (req, res) => {
  try {
    const { pass } = req.query;

    if (!pass) {
      return res.json({ success: false, msg: "Please provide a password" });
    }

    if (moment(req.decode.time).diff(moment(new Date()), "hours") > 1) {
      return res.json({ success: false, msg: "Token expired" });
    }

    const hashpassword = await bcrypt.hash(pass, 10);

    const result = await query(`UPDATE user SET password = ? WHERE email = ?`, [
      hashpassword,
      req.decode.old_email,
    ]);

    res.json({
      success: true,
      msg: "Your password has been changed. You may login now! Redirecting...",
      data: result,
    });
  } catch (err) {
    console.log(err);
    res.json({ msg: "Something went wrong", err, success: false });
  }
});

// generate api keys
router.get("/generate_api_keys", validateUser, async (req, res) => {
  try {
    const token = sign(
      { uid: req.decode.uid, role: "user" },
      process.env.JWTKEY,
      {}
    );

    // saving keys to user
    await query(`UPDATE user SET api_key = ? WHERE uid = ?`, [
      token,
      req.decode.uid,
    ]);

    res.json({ success: true, token, msg: "New keys has been generated" });
  } catch (err) {
    console.log(err);
    res.json({ msg: "Something went wrong", err, success: false });
  }
});

router.get("/fetch_profile", validateUser, async (req, res) => {
  try {
    // const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [req.decode.uid])

    const metaKeys = await query("SELECT * FROM meta_api WHERE uid = ?", [
      req.decode?.uid,
    ]);

    if (!metaKeys[0]?.access_token || !metaKeys[0]?.business_phone_number_id) {
      return res.json({
        success: false,
        msg: "Please fill the meta token and mobile id",
      });
    }
    const fetchProfile = await fetchProfileFun(
      metaKeys[0]?.business_phone_number_id,
      metaKeys[0]?.access_token
    );

    res.json(fetchProfile);
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// adding task for agent
router.post("/add_task_for_agent", validateUser, async (req, res) => {
  try {
    const { title, des, agent_uid } = req.body;
    if (!title || !des) {
      return res.json({ msg: "Please give title and description" });
    }

    if (!agent_uid) {
      return res.json({ msg: "Please select an agent" });
    }

    await query(
      `INSERT INTO agent_task (owner_uid, uid, title, description, status) VALUES (?,?,?,?,?)`,
      [req.decode.uid, agent_uid, title, des, "PENDING"]
    );

    res.json({ success: true, msg: "Task was added" });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// get my agent tasks
router.get("/get_my_agent_tasks", validateUser, async (req, res) => {
  try {
    const data = await query(
      `
            SELECT agent_task.*, agents.email AS agent_email
            FROM agent_task
            JOIN agents ON agents.uid = agent_task.uid
            WHERE agent_task.owner_uid = ?
        `,
      [req.decode.uid]
    );

    res.json({ data, success: true });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// delete task for agent
router.post("/del_task_for_agent", validateUser, async (req, res) => {
  try {
    const { id } = req.body;
    await query(`DELETE FROM agent_task WHERE id = ? AND owner_uid = ?`, [
      id,
      req.decode.uid,
    ]);

    res.json({ msg: "Task was deleted", success: true });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// add widget
router.post("/add_widget", validateUser, async (req, res) => {
  try {
    const { title, whatsapp_number, place, selectedIcon, logoType, size } =
      req.body;

    if (!title || !whatsapp_number || !place) {
      return res.json({ msg: "Please fill the details" });
    }

    let filename;

    if (logoType === "UPLOAD") {
      if (!req.files || Object.keys(req.files).length === 0) {
        return res.json({ success: false, msg: "Please upload a logo" });
      }

      const randomString = randomstring.generate();
      const file = req.files.file;

      filename = `${randomString}.${getFileExtension(file.name)}`;

      file.mv(`${__dirname}/../client/public/media/${filename}`, (err) => {
        if (err) {
          console.log(err);
          return res.json({ err });
        }
      });
    } else {
      filename = selectedIcon;
    }

    const unique_id = randomstring.generate(10);

    await query(
      `INSERT INTO chat_widget (unique_id, uid, title, whatsapp_number, logo, place, size) VALUES (?,?,?,?,?,?,?)`,
      [
        unique_id,
        req.decode.uid,
        title,
        whatsapp_number,
        filename,
        place,
        size || 50,
      ]
    );

    res.json({
      msg: "Widget was added",
      success: true,
    });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// get my widget
router.get("/get_my_widget", validateUser, async (req, res) => {
  try {
    const data = await query(`SELECT * FROM chat_widget WHERE uid = ?`, [
      req.decode.uid,
    ]);

    res.json({ data, success: true });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// del widget
router.post("/del_widget", validateUser, async (req, res) => {
  try {
    const { id } = req.body;

    await query(`DELETE FROM chat_widget WHERE id = ?`, [id]);

    res.json({ msg: "Widget was deleted", success: true });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

router.get("/widget", async (req, res) => {
  try {
    const { id } = req.query;

    if (!id) {
      return res.send(``);
    }

    const getWidget = await query(
      `SELECT * FROM chat_widget WHERE unique_id = ?`,
      [id]
    );

    if (getWidget.length < 1) {
      return res.send(``);
    }

    const url = generateWhatsAppURL(
      getWidget[0]?.whatsapp_number,
      getWidget[0]?.title
    );

    res.send(
      returnWidget(
        `${process.env.FRONTENDURI}/media/${getWidget[0]?.logo}`,
        getWidget[0]?.size,
        url,
        getWidget[0]?.place
      )
    );
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// update agent profile
router.post("/update_agent_profile", validateUser, async (req, res) => {
  try {
    const { email, name, mobile, newPas, uid } = req.body;

    if (!email || !name || !mobile) {
      return res.json({
        msg: "You can not remove any detail of agent",
      });
    }

    if (newPas) {
      const hasPas = await bcrypt.hash(newPas, 10);
      await query(
        `UPDATE agents SET email = ?, name = ?, mobile = ?, password = ? WHERE uid = ?`,
        [email, name, mobile, hasPas, uid]
      );
    } else {
      await query(
        `UPDATE agents SET email = ?, name = ?, mobile = ? WHERE uid = ?`,
        [email, name, mobile, uid]
      );
    }

    res.json({ msg: "Agent profile was updated", success: true });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// auto login agent
router.post("/auto_agent_login", validateUser, async (req, res) => {
  try {
    const { uid } = req.body;
    const agentFind = await query(`SELECT * FROM agents WHERE uid = ?`, [uid]);

    const token = sign(
      {
        uid: agentFind[0].uid,
        role: "agent",
        password: agentFind[0].password,
        email: agentFind[0].email,
        owner_uid: agentFind[0]?.owner_uid,
      },
      process.env.JWTKEY,
      {}
    );

    res.json({ token, success: true });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// add warmer message
router.post("/add_warmer_message", validateUser, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.json({ msg: "Please enter a message to add" });
    }

    await query(`INSERT INTO warmer_script (uid, message) VALUES (?,?)`, [
      req.decode.uid,
      message,
    ]);

    res.json({ msg: "Warmer message was added", success: true });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// get my warmer script
router.get("/get_warmer_script", validateUser, async (req, res) => {
  try {
    const data = await query(`SELECT * FROM warmer_script WHERE uid = ?`, [
      req.decode.uid,
    ]);
    res.json({ data, success: true });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// del a message
router.post("/del_warmer_msg", validateUser, async (req, res) => {
  try {
    const { id } = req.body;
    await query(`DELETE FROM warmer_script WHERE id = ? AND uid = ?`, [
      id,
      req.decode.uid,
    ]);
    res.json({ msg: "Message was deleted", success: true });
  } catch (err) {
    console.log(err);
    res.json({ msg: "something went wrong", err });
  }
});

// add to warmer
router.post(
  "/add_ins_to_warm",
  validateUser,
  checkPlan,
  checkWaWArmer,
  async (req, res) => {
    try {
      const { instance } = req.body;

      const getWarm = await query(`SELECT * FROM warmers WHERE uid = ?`, [
        req.decode.uid,
      ]);

      const addedIns = JSON.parse(getWarm[0]?.instances);

      if (addedIns.includes(instance)) {
        const finalIns = addedIns.filter((i) => i !== instance);

        await query(`UPDATE warmers SET instances = ? WHERE uid = ?`, [
          JSON.stringify(finalIns),
          req.decode.uid,
        ]);
      } else {
        const fiIns = [...addedIns, instance];
        await query(`UPDATE warmers SET instances = ? WHERE uid = ?`, [
          JSON.stringify(fiIns),
          req.decode.uid,
        ]);
      }

      res.json({
        msg: "Warmer updated",
        success: true,
      });
    } catch (err) {
      console.log(err);
      res.json({ msg: "something went wrong", err });
    }
  }
);

// get my warmer
router.get("/get_my_warmer", validateUser, async (req, res) => {
  try {
    const { uid } = req.decode;

    const getWarmer = await query(`SELECT * FROM warmers WHERE uid = ?`, [uid]);

    if (getWarmer?.length < 1) {
      await query(
        `INSERT INTO warmers (uid, instances, is_active) VALUES (?,?,?)`,
        [uid, JSON.stringify([]), 1]
      );

      // getting warmer again
      const warmer = await query(`SELECT * FROM warmers WHERE uid = ?`, [uid]);

      warmer[0].instances = JSON.parse(warmer[0].instances);
      res.json({ data: warmer[0], success: true });
    } else {
      getWarmer[0].instances = JSON.parse(getWarmer[0].instances);

      res.json({ data: getWarmer[0], success: true });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// change warmer status
router.post("/change_warmer_status", validateUser, async (req, res) => {
  try {
    const { status } = req.body;

    await query(`UPDATE warmers SET is_active = ? WHERE uid = ?`, [
      status ? 1 : 0,
      req.decode.uid,
    ]);

    res.json({ msg: "Status updated", success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// add google auth
router.post("/add_g_auth", validateUser, checkPlan, async (req, res) => {
  try {
    const { label, url } = req.body;
    console.log(req.body);
    if (!url || !label) {
      return res.json({
        msg: "Please upload and file and give a label to the auth",
      });
    }

    await query(`INSERT INTO g_auth (uid, label, url) VALUES (?,?,?)`, [
      req.decode.uid,
      label,
      url,
    ]);

    res.json({ success: true, msg: "Credentials uploaded" });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// get my creds
router.get("/get_my_g_creds", validateUser, async (req, res) => {
  try {
    const data = await query(`SELECT * FROM g_auth WHERE uid = ?`, [
      req.decode.uid,
    ]);
    res.json({ data, success: true });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

// router.post("/get_agent_report", validateUser, async (req, res) => {
//   try {
//     const { agentUid } = req.body;
//     // const agentChats = await query(
//     //   `SELECT * FROM beta_chats WHERE assigned_agent LIKE ?`,
//     //   [`%${req.decode.uid}%`]
//     // );

//     // const convo = await query(
//     //   `SELECT * FROM beta_conversation WHERE chat_id = ? LIMIT 5`,
//     //   ["919690309316_918430088300_lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8"]
//     // );

//     // console.log(JSON.stringify(convo)); = [{"id":3,"type":"text","chat_id":"919690309316_918430088300_lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","uid":"lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","status":null,"metaChatId":"3EB0174731FF56FF1016B5","msgContext":"{\"type\":\"text\",\"text\":{\"body\":\"hey yo\",\"preview_url\":true}}","reaction":"","timestamp":"1748528872","senderName":"codeyon.com","senderMobile":"918430088300","star":"0","route":"INCOMING","context":null,"origin":"qr","createdAt":"2025-05-29T14:27:52.000Z"},{"id":4,"type":"text","chat_id":"919690309316_918430088300_lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","uid":"lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","status":"delivered","metaChatId":"3EB0474435D1276E068EC3","msgContext":"{\"type\":\"text\",\"text\":{\"preview_url\":true,\"body\":\"Hello there, welcome to the chatbot how can i help?\\n\\nSupport or sales ?\"}}","reaction":"","timestamp":"1748528873","senderName":"codeyon.com","senderMobile":"918430088300","star":"0","route":"OUTGOING","context":null,"origin":"qr","createdAt":"2025-05-29T14:27:52.000Z"},{"id":5,"type":"text","chat_id":"919690309316_918430088300_lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","uid":"lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","status":null,"metaChatId":"3EB0B5F209F0276BE4D2B1","msgContext":"{\"type\":\"text\",\"text\":{\"body\":\"hi\",\"preview_url\":true}}","reaction":"","timestamp":"1748528889","senderName":"codeyon.com","senderMobile":"918430088300","star":"0","route":"INCOMING","context":null,"origin":"qr","createdAt":"2025-05-29T14:28:09.000Z"},{"id":6,"type":"text","chat_id":"919690309316_918430088300_lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","uid":"lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","status":"delivered","metaChatId":"3EB0EB4C14839114831269","msgContext":"{\"type\":\"text\",\"text\":{\"preview_url\":true,\"body\":\"Hello there, welcome to the chatbot how can i help?\\n\\nSupport or sales ?\"}}","reaction":"","timestamp":"1748528889","senderName":"codeyon.com","senderMobile":"918430088300","star":"0","route":"OUTGOING","context":null,"origin":"qr","createdAt":"2025-05-29T14:28:09.000Z"},{"id":7,"type":"text","chat_id":"919690309316_918430088300_lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","uid":"lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","status":null,"metaChatId":"3EB074C5C3F40FC8F63E3D","msgContext":"{\"type\":\"text\",\"text\":{\"body\":\"hi\",\"preview_url\":true}}","reaction":"","timestamp":"1748528931","senderName":"codeyon.com","senderMobile":"918430088300","star":"0","route":"INCOMING","context":null,"origin":"qr","createdAt":"2025-05-29T14:28:50.000Z"}]

//     // Total chats
//     // agentChats = [{"id":1,"uid":"lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","old_chat_id":null,"profile":"{\"profileImage\":\"https://pps.whatsapp.net/v/t61.24694-24/299565350_1011060832895306_6503983270112962656_n.jpg?ccb=11-4&oh=01_Q5Aa1gFKFah66vRyRU4AFN8GDLmunVNSpmKJrQ4KMJTBNzdD0A&oe=684BC664&_nc_sid=5e03e0&_nc_cat=103\"}","origin_instance_id":"{\"id\":\"919690309316:65@s.whatsapp.net\",\"lid\":\"186775309943014:65@lid\",\"name\":\"hamidsaifi.com\"}","chat_id":"919690309316_918430088300_lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","last_message":"{\"type\":\"text\",\"metaChatId\":\"3EB0072904F5E6697F373A\",\"msgContext\":{\"type\":\"text\",\"text\":{\"preview_url\":true,\"body\":\"We got this:\\nPassword: $2b$10$gf6jkuByoJUOF23GAl.WuesT6DUGiCA1LT8nnYWvQcXzfePGu4rrG\"}},\"reaction\":\"\",\"timestamp\":1748936511,\"senderName\":\"codeyon.com\",\"senderMobile\":\"918430088300\",\"star\":0,\"route\":\"OUTGOING\",\"context\":null,\"origin\":\"qr\"}","chat_label":null,"chat_note":"[]","sender_name":"codeyon.com","sender_mobile":"918430088300","unread_count":0,"origin":"qr","assigned_agent":"{\"id\":3,\"owner_uid\":\"lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8\",\"uid\":\"n9xrxIvwIajEo2JO2poQ0b3UyUnhUF3g\",\"role\":\"agent\",\"email\":\"john@agent.com\",\"password\":\"$2b$10$/LRIrp/i6vE0bKArKaDj7OzN/KxO.QUCZLT5rjo02VK96ka0FWjdO\",\"name\":\"john\",\"mobile\":\"7778888000\",\"comments\":\"some comments\",\"is_active\":1,\"createdAt\":\"2024-04-06T06:45:15.000Z\"}","createdAt":"2025-05-24T08:32:10.000Z"}]

//     // Time spent in panel
//     // const [agentData] = await query(`SELECT * FROM agents WHERE uid = ?`, [
//     //   req.decode.uid,
//     // ]);

//     // it has agentData.logs for Time spent in panel and Last login/logout

//     // Avg. response time = check all the chats and see when time reply means route cehck from the databse means SELECT * FROM beta_conversation WHRE chat_id = ? agentChatsarraymap.cat_id and then you will get all the arary and then check route of each message INCOMING then see next message OUTGOING and calculate the time difference

//     // Unread messages = check for unread_count in agentChats

//     // Open/Pending/Unresolved chats = check for agentChat has chat_label it might be anything like pending etc or remove or newOrder so check and get the chat label based how many are pending or let say if there are order label then how many are order etc

//     // const total convo
//     // const convoData = await query(`SELECT COUNT(*) where chat_id IN (?)`, [the agentChats.map(chat => chat.chat_id)]);

//     // Incoming/outgoing messages  you can check route INCOMING or OUTGOING in the beta_conversation table

//     // Date-based filters  make it so that i can fetch based on date too

//     const agentData = await query(`SELECT * FROM agents WHERE uid = ?`, [
//       agentUid,
//     ]);
//     // agentData = [{"id":3,"owner_uid":"lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8","uid":"n9xrxIvwIajEo2JO2poQ0b3UyUnhUF3g","role":"agent","email":"john@agent.com","password":"$2b$10$JGNSEHq.tErhcQKmvuh6PuWCVXWzxWIZ.WrnkuDNp8izuDgsWkZi.","name":"john","mobile":"7778888000","comments":"some comments","is_active":1,"createdAt":"2024-04-06T06:45:15.000Z","logs":"{\"dateTracking\":{\"2025-06-03\":{\"logins\":3,\"logouts\":3,\"lastLogin\":\"2025-06-03T12:44:57.454Z\",\"lastLogout\":\"2025-06-03T12:45:18.979Z\"}},\"spendTime\":{\"2025-06-03\":45}}"}]

//     res.json({ msg: "YO" });
//   } catch (err) {
//     console.error("Error fetching agent report:", err);
//     res.status(500).json({
//       success: false,
//       msg: "Failed to fetch agent report",
//       error: err.message,
//     });
//   }
// });

router.post("/get_agent_report_old", validateUser, async (req, res) => {
  try {
    let { agentUid, startDate, endDate } = req.body;

    // Validate date range
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        msg: "Start date and end date are required",
      });
    }

    // 1. Get agent data (including logs)
    const [agentData] = await query(`SELECT * FROM agents WHERE uid = ?`, [
      agentUid,
    ]);
    if (!agentData) {
      return res.status(404).json({
        success: false,
        msg: "Agent not found",
      });
    }

    // Parse agent logs
    const agentLogs = agentData.logs ? JSON.parse(agentData.logs) : {};

    // 2. Get all chats assigned to this agent
    const agentChats = await query(
      `SELECT * FROM beta_chats WHERE assigned_agent LIKE ? AND createdAt BETWEEN ? AND ?`,
      [`%${agentUid}%`, startDate, endDate]
    );

    // 3. Get all conversations for these chats
    const chatIds = agentChats.map((chat) => chat.chat_id);
    let allConvos = [];
    if (chatIds.length > 0) {
      allConvos = await query(
        `SELECT * FROM beta_conversation WHERE chat_id IN (?) ORDER BY timestamp ASC`,
        [chatIds]
      );
    }

    // Calculate metrics
    const metrics = {
      // Total chats assigned to agent
      totalChats: agentChats.length,

      // Time spent in panel (from logs)
      timeSpent: calculateTimeSpent(agentLogs, startDate, endDate),

      // Average response time
      avgResponseTime: calculateAvgResponseTime(allConvos),

      // Unread messages count
      unreadMessages: agentChats.reduce(
        (sum, chat) => sum + (chat.unread_count || 0),
        0
      ),

      // Chat status breakdown
      chatStatus: calculateChatStatus(agentChats),

      // Total messages count
      totalMessages: allConvos.length,

      // Incoming/outgoing breakdown
      messageDirection: calculateMessageDirection(allConvos),

      // Last login/logout
      lastActivity: getLastActivity(agentLogs),

      // Daily breakdown for table
      dailyMetrics: calculateDailyMetrics(
        agentChats,
        allConvos,
        agentLogs,
        startDate,
        endDate
      ),
    };

    res.json({
      success: true,
      data: {
        agentInfo: {
          name: agentData.name,
          email: agentData.email,
          mobile: agentData.mobile,
        },
        metrics,
      },
    });
  } catch (err) {
    console.error("Error fetching agent report:", err);
    res.status(500).json({
      success: false,
      msg: "Failed to fetch agent report",
      error: err.message,
    });
  }
});

// Helper functions
function calculateTimeSpent(logs, startDate, endDate) {
  let totalSeconds = 0;
  const start = new Date(startDate);
  const end = new Date(endDate);

  for (let date in logs.spendTime) {
    const currentDate = new Date(date);
    if (currentDate >= start && currentDate <= end) {
      totalSeconds += logs.spendTime[date] || 0;
    }
  }

  // Convert to hours and minutes
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function calculateAvgResponseTime(conversations) {
  let totalResponseTime = 0;
  let responseCount = 0;

  for (let i = 0; i < conversations.length - 1; i++) {
    const current = conversations[i];
    const next = conversations[i + 1];

    if (current.route === "INCOMING" && next.route === "OUTGOING") {
      const currentTime = new Date(current.createdAt).getTime();
      const nextTime = new Date(next.createdAt).getTime();
      totalResponseTime += (nextTime - currentTime) / 1000; // in seconds
      responseCount++;
    }
  }

  if (responseCount === 0) return "N/A";

  const avgSeconds = Math.round(totalResponseTime / responseCount);
  const minutes = Math.floor(avgSeconds / 60);
  const seconds = avgSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function calculateChatStatus(chats) {
  const statusCounts = {
    pending: 0,
    open: 0,
    resolved: 0,
    other: 0,
  };

  chats.forEach((chat) => {
    const label = chat.chat_label ? chat.chat_label.toLowerCase() : "other";
    if (label.includes("pending")) {
      statusCounts.pending++;
    } else if (label.includes("open")) {
      statusCounts.open++;
    } else if (label.includes("resolved")) {
      statusCounts.resolved++;
    } else {
      statusCounts.other++;
    }
  });

  return statusCounts;
}

function calculateMessageDirection(conversations) {
  return conversations.reduce(
    (acc, msg) => {
      acc[msg.route === "INCOMING" ? "incoming" : "outgoing"]++;
      return acc;
    },
    { incoming: 0, outgoing: 0 }
  );
}

function getLastActivity(logs) {
  if (!logs.dateTracking) return { lastLogin: "N/A", lastLogout: "N/A" };

  let lastLogin = null;
  let lastLogout = null;

  for (const date in logs.dateTracking) {
    const dayData = logs.dateTracking[date];
    if (
      dayData.lastLogin &&
      (!lastLogin || new Date(dayData.lastLogin) > new Date(lastLogin))
    ) {
      lastLogin = dayData.lastLogin;
    }
    if (
      dayData.lastLogout &&
      (!lastLogout || new Date(dayData.lastLogout) > new Date(lastLogout))
    ) {
      lastLogout = dayData.lastLogout;
    }
  }

  return {
    lastLogin: lastLogin ? formatDate(lastLogin) : "N/A",
    lastLogout: lastLogout ? formatDate(lastLogout) : "N/A",
  };
}

function calculateDailyMetrics(chats, convos, logs, startDate, endDate) {
  const dailyData = {};
  const start = new Date(startDate);
  const end = new Date(endDate);

  // Initialize all dates in range
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    dailyData[dateStr] = {
      date: dateStr,
      totalChats: 0,
      avgResponseTime: 0,
      incomingMessages: 0,
      outgoingMessages: 0,
      timeSpent: logs.spendTime?.[dateStr] || 0,
    };
  }

  // Count chats per day
  chats.forEach((chat) => {
    const chatDate = new Date(chat.createdAt).toISOString().split("T")[0];
    if (dailyData[chatDate]) {
      dailyData[chatDate].totalChats++;
    }
  });

  // Calculate response times and message counts per day
  const dailyConvos = {};
  convos.forEach((convo) => {
    const convoDate = new Date(convo.createdAt).toISOString().split("T")[0];
    if (!dailyConvos[convoDate]) {
      dailyConvos[convoDate] = [];
    }
    dailyConvos[convoDate].push(convo);
  });

  for (const date in dailyConvos) {
    if (dailyData[date]) {
      const dayConvos = dailyConvos[date];
      dailyData[date].incomingMessages = dayConvos.filter(
        (c) => c.route === "INCOMING"
      ).length;
      dailyData[date].outgoingMessages = dayConvos.filter(
        (c) => c.route === "OUTGOING"
      ).length;
      dailyData[date].avgResponseTime = calculateDailyResponseTime(dayConvos);
    }
  }

  return Object.values(dailyData);
}

function calculateDailyResponseTime(conversations) {
  let totalResponseTime = 0;
  let responseCount = 0;

  for (let i = 0; i < conversations.length - 1; i++) {
    const current = conversations[i];
    const next = conversations[i + 1];

    if (current.route === "INCOMING" && next.route === "OUTGOING") {
      const currentTime = new Date(current.createdAt).getTime();
      const nextTime = new Date(next.createdAt).getTime();
      totalResponseTime += (nextTime - currentTime) / 1000; // in seconds
      responseCount++;
    }
  }

  if (responseCount === 0) return 0;
  return Math.round(totalResponseTime / responseCount / 60); // in minutes
}

function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString();
}

router.post("/get_agent_report", validateUser, async (req, res) => {
  try {
    const { uid, startDate, endDate } = req.body;

    console.log({ uid, startDate, endDate });

    // Date validation and formatting
    const dateFilter = {};
    if (startDate && endDate) {
      dateFilter.chatDate = {
        start: new Date(startDate),
        end: new Date(endDate),
      };
    }

    // Get agent's chats with optional date filtering
    let agentChatsQuery = `SELECT * FROM beta_chats WHERE assigned_agent LIKE ?`;
    const agentChatsParams = [`%${uid}%`];

    if (dateFilter.chatDate) {
      agentChatsQuery += ` AND createdAt BETWEEN ? AND ?`;
      agentChatsParams.push(dateFilter.chatDate.start, dateFilter.chatDate.end);
    }

    const agentChats = await query(agentChatsQuery, agentChatsParams);

    // Get agent data including logs
    const agentData = await query(`SELECT * FROM agents WHERE uid = ?`, [uid]);

    // Calculate time spent in panel
    let totalTimeSpent = 0;
    let lastLogin = null;
    let lastLogout = null;

    if (agentData[0]?.logs) {
      const logs = JSON.parse(agentData[0].logs);
      if (logs.spendTime) {
        totalTimeSpent = Object.values(logs.spendTime).reduce(
          (sum, time) => sum + time,
          0
        );
      }
      if (logs.dateTracking) {
        const dates = Object.values(logs.dateTracking);
        if (dates.length > 0) {
          lastLogin = dates[dates.length - 1].lastLogin;
          lastLogout = dates[dates.length - 1].lastLogout;
        }
      }
    }

    // Get chat IDs for conversation query
    const chatIds = agentChats.map((chat) => chat.chat_id);

    // Initialize empty conversations array
    let conversations = [];

    // Only query conversations if we have chat IDs
    if (chatIds.length > 0) {
      // Get conversations with optional date filtering
      let conversationsQuery = `SELECT * FROM beta_conversation WHERE chat_id IN (?)`;
      const conversationsParams = [chatIds];

      if (dateFilter.chatDate) {
        conversationsQuery += ` AND createdAt BETWEEN ? AND ?`;
        conversationsParams.push(
          dateFilter.chatDate.start,
          dateFilter.chatDate.end
        );
      }

      conversationsQuery += ` ORDER BY createdAt ASC`; // Sort from oldest to newest
      conversations = await query(conversationsQuery, conversationsParams);
    }

    // Calculate metrics
    const metrics = {
      totalChats: agentChats.length,
      timeSpentInPanel: totalTimeSpent, // in minutes
      lastLogin,
      lastLogout,
      unreadMessages: agentChats.reduce(
        (sum, chat) => sum + (chat.unread_count || 0),
        0
      ),
      totalConversations: conversations.length,
      incomingMessages: conversations.filter((msg) => msg.route === "INCOMING")
        .length,
      outgoingMessages: conversations.filter((msg) => msg.route === "OUTGOING")
        .length,
    };

    // Calculate average response time
    let responseTimes = [];
    let lastIncoming = null;

    conversations.forEach((msg) => {
      if (msg.route === "INCOMING") {
        lastIncoming = new Date(msg.timestamp);
      } else if (msg.route === "OUTGOING" && lastIncoming) {
        const outgoingTime = new Date(msg.timestamp);
        const diff = (outgoingTime - lastIncoming) / 1000; // in seconds
        responseTimes.push(diff);
        lastIncoming = null;
      }
    });

    metrics.avgResponseTime =
      responseTimes.length > 0
        ? Math.round(
            responseTimes.reduce((sum, time) => sum + time, 0) /
              responseTimes.length
          )
        : 0;

    // Calculate chat status counts
    const statusCounts = {
      open: 0,
      pending: 0,
      unresolved: 0,
      important: 0,
    };

    agentChats.forEach((chat) => {
      if (chat.chat_label) {
        const label = JSON.parse(chat.chat_label);
        if (label.title === "Important") statusCounts.important++;
        // Add more status checks as needed
      }
      // Add other status checks based on your business logic
    });

    metrics.statusCounts = statusCounts;

    res.json({
      success: true,
      data: {
        metrics,
        agentData: agentData[0],
        conversations: conversations.slice(0, 100), // Limit to 100 most recent
        agentChats: agentChats.slice(0, 100), // Limit to 100 most recent
      },
    });
  } catch (err) {
    console.error(err);
    res.json({
      success: false,
      msg: "Failed to generate agent report",
      err: err.message,
    });
  }
});

router.get("/get_my_meta_templets_beta", validateUser, async (req, res) => {
  try {
    console.log({ query: req.query });

    const getMETA = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      req.decode.uid,
    ]);
    if (getMETA.length < 1) {
      return res.json({
        success: false,
        msg: "Please check your meta API keys",
      });
    }

    // Add pagination and filtering options
    const limit = req.query.limit || 9;
    const after = req.query.after || null;
    const before = req.query.before || null;
    const status = req.query.status || "APPROVED";

    const resp = await getAllTempletsMetaBeta(
      "v21.0", // Use your API version
      getMETA[0]?.waba_id,
      getMETA[0]?.access_token,
      limit,
      after,
      before,
      status
    );

    if (resp?.error) {
      res.json({
        success: false,
        msg: resp?.error?.message || "Please check your API",
      });
    } else {
      // Process templates to extract variable information
      const templatesWithVars =
        resp?.data?.map((template) => {
          const variables = extractTemplateVariablesBeta(template);
          return {
            ...template,
            variables,
          };
        }) || [];

      res.json({
        success: true,
        data: templatesWithVars,
        paging: resp?.paging || {},
      });
    }
  } catch (err) {
    res.json({ success: false, msg: "something went wrong", err });
    console.log(err);
  }
});

router.post("/send_template_message", validateUser, async (req, res) => {
  try {
    const {
      template_name,
      template_language = "en_US",
      recipient_phone,
      body_variables = [],
      header_variable = null,
      button_variables = [],
    } = req.body;

    // Validate required fields
    if (!template_name || !recipient_phone) {
      return res.json({
        success: false,
        msg: "Template name and recipient phone are required",
      });
    }

    // Format phone number (ensure it has country code)
    const formattedPhone = formatPhoneNumber(recipient_phone);

    // Get user's Meta API credentials
    const getMETA = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      req.decode.uid,
    ]);

    if (getMETA.length < 1) {
      return res.json({
        success: false,
        msg: "Please check your meta API keys",
      });
    }

    // Send the template message
    const response = await sendTemplateMessage(
      "v18.0",
      getMETA[0]?.business_phone_number_id,
      getMETA[0]?.access_token,
      template_name,
      template_language,
      formattedPhone,
      body_variables,
      header_variable,
      button_variables
    );

    if (response?.error) {
      return res.json({
        success: false,
        msg: response?.error?.message || "Failed to send template message",
        error: response.error,
      });
    }

    res.json({
      success: true,
      msg: "Template message sent successfully",
      data: response,
    });
  } catch (err) {
    console.error("Error sending template message:", err);
    res.json({
      success: false,
      msg: "Something went wrong while sending the template",
      error: err.message,
    });
  }
});

module.exports = router;
