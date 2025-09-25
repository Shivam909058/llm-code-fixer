# LLM Code Fixer

An AI-powered tool that uses vector stores and LLMs (via OpenAI) to automatically detect and fix bugs in JavaScript codebases. It supports syntax, runtime, and logic errors, with an interactive CLI for providing extra context.

## Installation

Install globally for CLI access:
```bash
npm install -g llm-code-fixer
```

Set your OpenAI API key:
```bash
export OPENAI_API_KEY=your-api-key-here  # On Windows: set OPENAI_API_KEY=your-api-key-here
```

## Usage

Run the CLI to fix a buggy file:
```bash
fix-code <path-to-buggy-file>
```

- You'll be prompted for error logs and instructions (optional but recommended for better fixes).
- The tool will iteratively fix issues (up to 5 rounds) and output the result.
- Backups of original files are saved in your temp directory (e.g., `/tmp/llm_fixes` or `%TEMP%\llm_fixes`).

### Example
```bash
fix-code buggy.js
```

Paste errors/instructions when prompted, e.g.:
```
Errors: ReferenceError: x is not defined
Instructions: Add default values for variables.
```

## Inline Usage

Import and use in your code:
```js
import { tryq, fixAndTestFile } from 'llm-code-fixer';

// Wrap a function to auto-fix errors
await tryq(myBuggyFunction);
```

## Dependencies

**Required:** OpenAI API key.  
**Optional:** faiss-node for faster vector search (`npm install faiss-node`).

## License

MIT

## Development

### Install Dependencies Locally (for Testing)
In the `llm-code-fixer` directory:
```bash
npm install
```

### Test the CLI Locally
```bash
node fix-cli.js <path-to-some-buggy-file>
```

