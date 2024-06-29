#!/usr/bin/env node

import fs from "fs";
import got from "got";
import path from "path";
import { pipeline as streamPipeline } from 'node:stream/promises';

let args = { url: null, dst: null };

//-Parse argument
function parseArgs() {
  for (let arg of process.argv) {
    Object.keys(args).forEach((key) => {
      if (arg.trim().startsWith(key + ":")) {
        args[key] = arg.substring(key.length + 1);
      }
    });
  }
}

function isAllArgsPresent() {
  return Object.values(args).filter((v) => v == null).length == 0;
}

//-Dump files
async function extractHref(pageHtml) {
  let regexFiles = /href="([\w\-\.]+)"/gm;
  let regexFolders = /href="([\w\-\.]+\/)"/gm;
  let files = pageHtml.match(regexFiles) ?? [];
  let folders = pageHtml.match(regexFolders) ?? [];
  files = files.map((f) => f.substring(6, f.length - 1));
  folders = folders.map((f) => f.substring(6, f.length - 1));
  console.log(`-> found ${files.length} files and ${folders.length} folders.`);
  return { files, folders };
}

async function discoverTree(url, currentFolder = "", tree = {}) {
  console.log(`👀 url: ${url}...`);
  let pageHtml = await got(url).text();
  let href = await extractHref(pageHtml);

  tree[currentFolder] = { files: href.files };

  for (let folder of href.folders) {
    await discoverTree(url + folder, currentFolder + folder, tree);
  }
  return tree;
}

async function downloadTree(baseUrl, tree, dst) {
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(dst);
  }


  for (let key of Object.keys(tree)) {
    if (tree[key].files.length <= 0) {
      console.info(`ℹ: Skip "${key}" folder (it's empty)...`);
      continue;
    }
    console.log(`Download: ${key}...`);
    let destFolder = path.join(dst, key);
    fs.mkdirSync(destFolder, { recursive: true });
    for (let file of tree[key].files) {
      let destFile = destFolder + file;
      if (fs.existsSync(destFile)) {
        console.info(`ℹ: Skip "${destFile}" file (already exists)...`);
        continue;
      }
      const stream = got.stream(baseUrl + key + file, { timeout: { request: 60000 } });
      await streamPipeline(stream, fs.createWriteStream(destFile));
    }
  }
}
/* ---- MAIN ---- */
try {
  parseArgs();
  if (!isAllArgsPresent()) {
    console.log("Usage: node dump.js url:http://{website}/.git/ dst:folderName");
    process.exit(1);
  }
  //-Create dest folder
  fs.mkdirSync(args.dst, { recursive: true });
  //-Recursive build files tree
  let tree = await discoverTree(args.url);
  //-Download all files
  await downloadTree(args.url, tree, path.join(args.dst, ".git/"));
  console.log("✅ Done.");
} catch (err) {
  console.error("ERROR: ", err, err?.url);
}
