// fix-cli.js - CLI to fix and test a buggy JavaScript file using main.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fixAndTestFile } from "./main.js";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function promptUser(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function runCli() {
  // Get file path from command-line argument
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node fix-cli.js <path-to-buggy-file>");
    process.exit(1);
  }

  // Resolve the absolute path
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`Error: File ${absPath} does not exist.`);
    process.exit(1);
  }

  // Compute relative path relative to ROOT_DIR (same as main.js)
  const ROOT_DIR = path.resolve(path.join(__dirname, ".."));
  const relativePath = path.relative(ROOT_DIR, absPath);
  console.log(`Attempting to fix and test: ${relativePath} (absolute: ${absPath})`);

  // Prompt user for errors and instructions combined
  const userInput = await promptUser("Paste the errors you are facing and any additional instructions (or press Enter to skip): ");
  rl.close();

  const extraContext = userInput ? `User-reported errors and instructions: ${userInput}\n` : '';

  // Run fixAndTestFile with extraContext
  const result = await fixAndTestFile(relativePath, { testExportName: "run", maxRounds: 5, extraContext });

  if (result.ok) {
    console.log(`🎉 Success after ${result.rounds} round(s)! Output:`, result.out);
    console.log("Fix history:", result.history.map(h => ({
      round: h.round,
      error: h.error || h.attempt?.error,
      fixed: h.fixRes?.results?.length > 0 || h.attempt?.fix?.results?.length > 0,
    })));
  } else {
    console.error(`❌ Failed to fix after ${result.rounds} round(s). Last error:`, result.error);
    console.log("Fix history:", result.history.map(h => ({
      round: h.round,
      error: h.error || h.attempt?.error,
      fixed: h.fixRes?.results?.length > 0 || h.attempt?.fix?.results?.length > 0,
    })));
    console.log("Check the file for partial fixes or review the backup in", path.join(require("os").tmpdir(), "llm_fixes"));
  }
}

runCli().catch(err => {
  console.error("CLI error:", err.message);
  process.exit(1);
});