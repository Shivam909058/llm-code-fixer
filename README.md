# LLM Code Fixer

An AI-powered tool that uses vector stores and LLMs (via OpenAI) to automatically detect and fix bugs in JavaScript codebases. It supports syntax, runtime, and logic errors, with an interactive CLI for providing extra context.

## Installation

Clone or download the repository to your local machine. Navigate to the project directory (e.g., the folder containing `main.js` and `cli.js`).

Install dependencies:
```bash
npm install
```

Set your OpenAI API key:
```bash
export OPENAI_API_KEY=your-api-key-here  # On Windows: set OPENAI_API_KEY=your-api-key-here
```

## Usage

### Primary Method: Run Directly with Node

The simplest way to use the tool is to run the CLI script directly with Node.js. This avoids global installation issues and works out of the box.

From the project directory:
```bash
node cli.js <path-to-buggy-file>
```

**Example:**
```bash
node cli.js test.js
```

- You'll be prompted for error logs and instructions (optional but recommended for better fixes)
- The tool will iteratively fix issues (up to 5 rounds) and output the result
- Backups of original files are saved in your temp directory (e.g., `/tmp/llm_fixes` or `%TEMP%\llm_fixes` on Windows)

### Prompt Example
When prompted, provide context like:
```
Errors: ReferenceError: x is not defined
Instructions: Add default values for variables and fix the syntax errors.
```

### Optional: Global Installation via NPM

If you prefer a global CLI command (`fix-code`), you can package and install it globally.

1. In the project directory, ensure you have a proper `package.json` file
2. Run:
   ```bash
   npm link
   ```
3. Then use:
   ```bash
   fix-code <path-to-buggy-file>
   ```

For sharing with others, publish to NPM:
```bash
npm publish --access public
```

Then others can install globally with:
```bash
npm install -g llm-code-fixer
```

## Inline Usage

Import and use in your code:
```js
import { tryq, fixAndTestFile } from './main.js';

// Wrap a function to auto-fix errors
await tryq(myBuggyFunction);
```

## Dependencies

**Required:** OpenAI API key  
**Optional:** `faiss-node` for faster vector search (`npm install faiss-node`)

## License

MIT
s and prompts
