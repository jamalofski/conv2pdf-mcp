# conv2pdf-mcp

Official [Model Context Protocol](https://modelcontextprotocol.io) server of the [conv2pdf API](https://conv2pdf.com/en/api/). Your AI assistant converts Word, Excel, PowerPoint, Pages, images and e-books to PDF, converts PDFs to Word or to images, and merges, compresses, protects, rotates or numbers the PDFs that are on your computer. Processing runs on OVHcloud servers in France: no transfer outside the EU, no US service in the chain.

[Installation](#installation) · [Tools](#tools) · [How it behaves](#how-it-behaves) · [Development](#development)

## Installation

1. Create an account on [conv2pdf.com](https://conv2pdf.com/en/api/). The Dev plan includes 300 free conversions, valid for 12 months; see [pricing](https://conv2pdf.com/en/api/pricing/) for the paid plans.
2. Create an API key, which starts with `cpdf_live_`, in the **Developer** tab of your dashboard. conv2pdf shows it only once, at creation.
3. Add the server to your MCP client, with the key in the `CONV2PDF_API_KEY` environment variable. It needs [Node.js](https://nodejs.org) 22 or later.

In Claude Code:

```bash
claude mcp add --env CONV2PDF_API_KEY=cpdf_live_... --transport stdio conv2pdf -- npx -y conv2pdf-mcp
```

In Claude Desktop, Cursor and the other clients configured with a JSON file:

```json
{
  "mcpServers": {
    "conv2pdf": {
      "command": "npx",
      "args": ["-y", "conv2pdf-mcp"],
      "env": { "CONV2PDF_API_KEY": "cpdf_live_..." }
    }
  }
}
```

Then ask for what you need: "convert report.docx to PDF", "merge these three PDFs", "compress scan.pdf and protect it with a password".

## Tools

| Tool | What it does |
|---|---|
| `convert_to_pdf` | Word, Excel, PowerPoint, OpenDocument, Apple Pages, RTF, TXT, CSV, PNG, JPG, WebP, GIF, TIFF, HEIC or EPUB file to PDF, chosen from the extension |
| `convert_heic_to_jpg` | iPhone HEIC or HEIF photo to JPG |
| `convert_pdf_to_word` | PDF with real text to an editable DOCX document |
| `convert_pdf_to_images` | One PNG or JPG per page, in a ZIP file |
| `merge_pdfs` | Combine several PDFs into one, in the order given |
| `extract_pdf_pages` | Keep the pages you list, such as `1-5,7,10-12`, in a new PDF |
| `rotate_pdf` | Turn every page by 90, 180 or 270 degrees |
| `add_page_numbers` | Number the pages, as "3 / 12" or "3", bottom center, left or right |
| `add_watermark` | Stamp a text of up to 50 characters on every page |
| `compress_pdf` | Reduce the size, keeping images at 72, 150 or 300 DPI |
| `protect_pdf` | Set a password, and optionally forbid printing or copying |
| `unlock_pdf` | Remove a password you know, or the printing and copying restrictions |
| `get_quota` | Plan, usage and limits of the API key |

## How it behaves

- **Files stay on your computer, except for the conversion.** A tool takes the path of a file, sends the file to conv2pdf and writes the result on your disk. conv2pdf checks the content of the file, not only its name.
- **Nothing is overwritten.** The result goes next to the input file: `report.docx` gives `report.pdf`, and a PDF tool adds a suffix, such as `report-compressed.pdf`. When that name is taken, the server writes `report (2).pdf`. The assistant can choose the place with `output_path`; if a file is already there, the tool refuses before converting anything.
- **Deleted from the server.** Once the result is on your disk, the server deletes the job from conv2pdf. Should that fail, conv2pdf deletes the files after one hour.
- **Quota.** Each conversion counts as one in the quota of your plan, including one that conv2pdf refuses after reading the file, such as an unreadable PDF or a page range that does not exist. A file refused on arrival (wrong type, too large, password missing) and a failure on the side of conv2pdf count for nothing, and `get_quota` is free. Files can weigh up to 10 MB on the Dev plan and 200 MB on paid plans.
- **Rate limit.** The API accepts 20 conversions per minute per API key. When it asks to slow down, or when its queue is full, the server waits for the delay the API gives and tries again, twice at most and only for delays of 30 seconds or less; otherwise the assistant gets the delay to wait.
- **Protected PDFs.** The tools that read a PDF, except `merge_pdfs`, open one that asks for a password when the assistant passes it as `password`. The result has no password. For a merge, unlock the protected PDFs first.
- **Pages and Numbers.** A Pages document keeps its `.pages` extension: only the name tells it from a Numbers spreadsheet, which conv2pdf does not convert, like Keynote presentations.
- **Errors.** A refusal comes back to the assistant as a sentence it can act on: the wrong password, the page range that does not exist, the plan limit, the key to set. A cancelled call stops the transfer and leaves no file behind.
- **Without a key.** The server starts and lists its tools; a call explains how to set `CONV2PDF_API_KEY`.

Every request carries `User-Agent: conv2pdf-mcp/<version>`. Mention it when you contact support: it tells your calls apart in the API's logs.

## Development

The server has no dependency: Node.js runs the sources as they are. It talks to its client over stdio and serves both eras of the protocol from the same process: revision 2026-07-28, where each request carries its protocol version, and the earlier revisions (2025-11-25 down to 2024-11-05), which start with an `initialize` handshake.

```bash
npm test
```

runs the tests against a fake conv2pdf API on a local port: no key and no network are needed.

```bash
npm run check-tools
```

compares the extensions `convert_to_pdf` routes on with what the live API accepts (`GET /v1/tools`).

### Releasing

1. Set the version in `package.json` and `server.json`, and date its section in `CHANGELOG.md`.
2. Run `npm test` and `npm run check-tools`.
3. Commit, then push a tag named after the version: the **Publish** workflow publishes the package to npm through Trusted Publishing, with a provenance statement.
4. Publish the entry of the [MCP Registry](https://registry.modelcontextprotocol.io): `mcp-publisher login http --domain conv2pdf.com`, then `mcp-publisher publish`. The name `com.conv2pdf/conv2pdf` is proved by the public key served at `https://conv2pdf.com/.well-known/mcp-registry-auth`.

## Resources

- [conv2pdf API documentation](https://conv2pdf.com/en/api/docs/)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/2026-07-28)

## Support

Open an [issue](https://github.com/jamalofski/conv2pdf-mcp/issues) or write to contact@conv2pdf.com.

## License

MIT, see [LICENSE](LICENSE).
