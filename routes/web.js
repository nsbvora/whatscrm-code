const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const {
  validateEmail,
  getFileExtension,
  folderExists,
  downloadAndExtractFile,
  executeQueries,
  isValidEmail,
  sendEmailBeta,
} = require("../functions/function.js");
const adminValidator = require("../middlewares/admin.js");
const fs = require("fs");
const randomstring = require("randomstring");
const path = require("path");
const { appVersion, addON } = require("../env.js");
const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");
const { getAllSocketData } = require("../socket.js");
const { checkQr } = require("../helper/addon/qr/index.js");
const { handleIncomingMessage } = require("../automation/automation.js");

router.get("/", async (req, res) => {
  try {
    const convo = await query(`SELECT * FROM beta_conversation LIMIT 5`, []);
    res.json(convo);
  } catch (err) {
    res.json({ err, msg: "server error" });
    console.log(err);
  }
});

router.get("/get_all", async (req, res) => {
  try {
    const data = getAllSocketData();
    res.json({ data, id: req.query.id });
  } catch (err) {
    res.json({ err, msg: "server error" });
    console.log(err);
  }
});

router.get("/return_module", async (req, res) => {
  try {
    const qrCheck = checkQr();
    const finalAddon = qrCheck ? [...addON, "QR"] : addON;
    res.json({ success: true, data: finalAddon || [] });
  } catch (err) {
    res.json({ err, msg: "server error" });
    console.log(err);
  }
});

// Modified backend route to support pagination and search
router.get("/get-one-translation", async (req, res) => {
  try {
    const cirDir = process.cwd();
    const code = req.query.code;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 0; // 0 means no limit, return all
    const search = req.query.search || "";

    fs.readFile(`${cirDir}/languages/${code}.json`, "utf8", (err, lang) => {
      if (err) {
        console.log("File read failed:", err);
        res.json({ notfound: true });
        return;
      }

      try {
        const parsedData = JSON.parse(lang);

        // If no pagination or search is requested, return all data
        if (!search && !limit) {
          return res.json({
            success: true,
            data: parsedData,
            total: Object.keys(parsedData).length,
          });
        }

        // Filter by search term if provided
        let filteredData = parsedData;
        if (search) {
          const searchLower = search.toLowerCase();
          const filtered = {};

          Object.keys(parsedData).forEach((key) => {
            if (
              key.toLowerCase().includes(searchLower) ||
              String(parsedData[key]).toLowerCase().includes(searchLower)
            ) {
              filtered[key] = parsedData[key];
            }
          });

          filteredData = filtered;
        }

        // Apply pagination if limit is specified
        if (limit > 0) {
          const keys = Object.keys(filteredData);
          const totalItems = keys.length;
          const startIndex = (page - 1) * limit;
          const endIndex = startIndex + limit;
          const paginatedKeys = keys.slice(startIndex, endIndex);

          const paginatedData = {};
          paginatedKeys.forEach((key) => {
            paginatedData[key] = filteredData[key];
          });

          return res.json({
            success: true,
            data: paginatedData,
            pagination: {
              total: totalItems,
              page,
              limit,
              pages: Math.ceil(totalItems / limit),
            },
          });
        }

        // Return all filtered data if no pagination
        res.json({
          success: true,
          data: filteredData,
          total: Object.keys(filteredData).length,
        });
      } catch (parseError) {
        console.log("JSON parse error:", parseError);
        res.json({ success: false, error: "Invalid JSON format" });
      }
    });
  } catch (err) {
    res.json({ err, msg: "server error" });
    console.log(err);
  }
});

router.get("/get-all-translation-name", async (req, res) => {
  try {
    const cirDir = `${__dirname}/../languages/`;
    fs.readdir(`${cirDir}`, (err, files) => {
      res.json({ success: true, data: files });
    });
  } catch (err) {
    res.json({
      msg: "Server error",
      err: err,
    });
    console.log(err);
  }
});

router.post("/update-one-translation", adminValidator, async (req, res) => {
  try {
    const cirDir = process.cwd();
    const code = req.body.code;
    const updatedJson = req.body.updatedjson;

    const filePath = path.join(cirDir, "languages", `${code}.json`);

    fs.writeFile(filePath, JSON.stringify(updatedJson), "utf8", (err) => {
      if (err) {
        console.log("File write failed:", err);
        res.json({ success: false, error: err });
        return;
      }
      res.json({
        success: true,
        msg: "Languages updated refresh the page to make effects",
      });
    });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// submit contact form
router.post("/submit_contact_form", async (req, res) => {
  try {
    const { name, mobile, email, content } = req.body;

    if (!name || !mobile || !email || !content) {
      return res.json({ success: false, msg: "Please fill all the fields" });
    }

    if (!validateEmail(email)) {
      return res.json({ success: false, msg: "Please enter a valid email id" });
    }

    await query(
      `INSERT INTO contact_form (email, name, mobile, content) VALUES (?,?,?,?)`,
      [email, name, mobile, content]
    );

    res.json({
      success: true,
      msg: "Your form has been submitted. We will contat to your asap",
    });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// update  web config
router.post("/update_web_config", adminValidator, async (req, res) => {
  try {
    const {
      app_name,
      custom_home,
      is_custom_home,
      meta_description,
      currency_code,
      currency_symbol,
      home_page_tutorial,
      chatbot_screen_tutorial,
      broadcast_screen_tutorial,
      login_header_footer,
      exchange_rate,
    } = req.body;

    let filename = "";

    if (req.files) {
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
      filename = req.body?.logo;
    }

    if (!app_name) {
      return res.json({ msg: "Please provide app name" });
    }

    await query(
      `UPDATE web_public SET logo = ?, app_name = ?, custom_home = ?, is_custom_home = ?, meta_description = ?, currency_code = ? , 
        currency_symbol = ?, 
        home_page_tutorial = ?,
        chatbot_screen_tutorial = ?,
        broadcast_screen_tutorial = ?,
        login_header_footer = ?,
        exchange_rate = ?`,
      [
        filename,
        app_name,
        custom_home,
        parseInt(is_custom_home) > 0 ? 1 : 0,
        meta_description,
        currency_code,
        currency_symbol,
        home_page_tutorial,
        chatbot_screen_tutorial,
        broadcast_screen_tutorial,
        login_header_footer,
        exchange_rate,
      ]
    );

    res.json({ success: true, msg: "Web config updated" });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// add new languages
router.post("/add-new-translation", adminValidator, async (req, res) => {
  try {
    const cirDir = process.cwd();
    const newCode = req.body.newcode;

    const sourceFolderPath = path.join(cirDir, "languages");

    fs.readdir(sourceFolderPath, (err, files) => {
      if (err) {
        console.log("Error reading folder:", err);
        res.json({ success: false, error: err });
        return;
      }

      // Filter out non-JSON files
      const jsonFiles = files.filter((file) => file.endsWith(".json"));

      // Select a random JSON file
      const randomIndex = Math.floor(Math.random() * jsonFiles.length);
      const randomFile = jsonFiles[randomIndex];

      const sourceFilePath = path.join(sourceFolderPath, randomFile);
      const destinationFilePath = path.join(
        sourceFolderPath,
        `${newCode}.json`
      );

      // Check if the destination file already exists
      if (fs.existsSync(destinationFilePath)) {
        res.json({ success: false, msg: "Destination file already exists" });
        return;
      }

      // Duplicate the source file to the destination file
      fs.copyFile(sourceFilePath, destinationFilePath, (err) => {
        if (err) {
          console.log("File duplication failed:", err);
          res.json({ success: false, error: err });
          return;
        }
        res.json({
          success: true,
          msg: "Language file duplicated successfully",
        });
      });
    });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// get all langs
router.get("/get-all-translation-name", async (req, res) => {
  try {
    const cirDir = process.cwd();
    fs.readdir(`${cirDir}/languages/`, (err, files) => {
      res.json({ success: true, data: files });
    });
  } catch (err) {
    res.json({
      msg: "Server error",
      err: err,
    });
    console.log(err);
  }
});

// del one lang
router.post("/del-one-translation", adminValidator, async (req, res) => {
  try {
    const cirDir = process.cwd();
    const code = req.body.code;

    const folderPath = path.join(cirDir, "languages");
    const filePath = path.join(folderPath, `${code}.json`);

    // Read the list of files in the "languages" folder
    fs.readdir(folderPath, (err, files) => {
      if (err) {
        console.log("Error reading folder:", err);
        res.json({ success: false, error: err });
        return;
      }

      // Filter out non-JSON files
      const jsonFiles = files.filter((file) => file.endsWith(".json"));

      // Check if there is only one JSON file left
      if (jsonFiles.length === 1) {
        res.json({ success: false, msg: "You cannot delete all languages" });
        return;
      }

      fs.unlink(filePath, (err) => {
        if (err) {
          console.log("File deletion failed:", err);
          res.json({ success: false, error: err });
          return;
        }
        res.json({ success: true, msg: "Language file deleted successfully" });
      });
    });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// check install
router.get("/check_install", async (req, res) => {
  try {
    const filePath = `${__dirname}/../client/public/static`;

    const check = folderExists(filePath);

    if (check) {
      return res.json({ success: true });
    } else {
      return res.json({ success: false });
    }
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// get app version
router.get("/get_app_version", async (req, res) => {
  try {
    res.json({ success: true, version: appVersion });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// install app
router.post("/install_app", async (req, res) => {
  try {
    const filePath = `${__dirname}/../client/public/static`;

    const check = folderExists(filePath);

    if (check) {
      return res.json({ success: true, msg: "Your app is already installed" });
    }

    const outputPath = `${__dirname}/../client/public`;

    const installApp = await downloadAndExtractFile(req.files, outputPath);

    res.json(installApp);
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// update app
router.post("/update_app", async (req, res) => {
  try {
    const { password, queries, newQueries } = req.body;

    if (!password) {
      return res.json({ msg: "Admin password missing", success: false });
    }

    const getAdmin = await query("SELECT * FROM admin", []);

    const compare = await bcrypt.compare(password, getAdmin[0].password);
    if (!compare) {
      return res.json({
        msg: "Invalid admin password. Please give a correct admin password",
      });
    }

    // Create a MySQL connection pool
    const pool = mysql.createPool({
      host: process.env.DBHOST || "localhost",
      user: process.env.DBUSER,
      password: process.env.DBPASS,
      database: process.env.DBNAME,
      connectionLimit: 10, // Limit the number of concurrent connections
    });

    if (queries && JSON.parse(queries)?.length > 0) {
      const parsedQueries = JSON.parse(queries);
      if (Array.isArray(parsedQueries) && parsedQueries.length > 0) {
        await executeQueries(parsedQueries, pool);
      }
    }

    if (newQueries && JSON.parse(newQueries)?.length > 0) {
      const newQuery = JSON.parse(newQueries);
      await Promise.all(
        newQuery?.map(async (i) => {
          const { run, check } = i;
          const connection = await pool.getConnection(); // Get a connection from the pool
          try {
            const checkExist = await connection.query(check);
            if (checkExist[0].length < 1) {
              await connection.query(run);
            }
          } finally {
            connection.release(); // Always release the connection back to the pool
          }
        })
      );
    }

    const outputPath = `${__dirname}/../`;

    const installApp = await downloadAndExtractFile(req.files, outputPath);

    res.json(installApp);
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// update to be shown
router.get("/update_to_be_shown", async (req, res) => {
  try {
    res.json({ success: true, show: true });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// get web public
router.get("/get_web_public", async (req, res) => {
  try {
    const data = await query(`SELECT * FROM web_public`, []);
    res.json({ data: data[0], success: true });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// get theme
router.get("/get_theme", async (req, res) => {
  try {
    fs.readFile(`${__dirname}/theme.json`, "utf8", (err, lang) => {
      if (err) {
        console.log("File read failed:", err);
        res.json({
          success: false,
          msg: "Somethign went wrong with the theme setting",
        });
        return;
      }

      res.json({
        success: true,
        data: JSON.parse(lang),
      });
    });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

// save theme
router.post("/save_theme", adminValidator, async (req, res) => {
  try {
    const { updatedJson } = req.body;

    const filePath = path.join(`${__dirname}/theme.json`);

    fs.writeFile(filePath, JSON.stringify(updatedJson), "utf8", (err) => {
      if (err) {
        console.log("File write failed:", err);
        res.json({ success: false, error: err });
        return;
      }
      res.json({
        success: true,
        msg: "Theme was updated",
      });
    });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

function createWhatsAppLink(mobileNumber, message = "") {
  // Base URL for WhatsApp API
  const baseURL = "https://wa.me/";

  // Encode the message for URL
  const encodedMessage = encodeURIComponent(message);

  // Create the complete URL
  const url = `${baseURL}${mobileNumber}?text=${encodedMessage}`;

  return url;
}

// generate whatsapp link
router.post("/gen_wa_link", async (req, res) => {
  try {
    const { mobile, email, msg } = req.body;

    if (!mobile || !email) {
      return res.json({ msg: "Ops.. mobile and email fields are required" });
    }

    if (!isValidEmail(email)) {
      return res.json({ msg: "Please provide a valid email id" });
    }

    await query(
      `INSERT INTO gen_links (wa_mobile, email, msg) VALUES (?,?,?)`,
      [mobile, email, msg]
    );

    res.json({
      success: true,
      data: createWhatsAppLink(mobile?.replace("+", ""), msg),
    });
  } catch (err) {
    res.json({ success: false, error: err, msg: "Server error", err });
    console.log(err);
  }
});

router.post("/test", (req, res) => {
  const body = req.body;
  const headers = req.headers;
  const contentType = req.get("Content-Type");

  console.log({ body: req.body });

  res.json({
    success: true,
    body,
    headers,
    contentType,
  });
});

module.exports = router;
