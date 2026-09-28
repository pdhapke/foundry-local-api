import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Buffer } from "node:buffer";

const [toolName, encodedArguments = "e30="] = process.argv.slice(2);
const apiKey = process.env.FOUNDRY_API_KEY;
if (!apiKey) throw new Error("FOUNDRY_API_KEY is not set.");

const client = new Client({ name: "foundry-local-api-live-acceptance", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3939/mcp"), {
  requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
});

try {
  await client.connect(transport);
  if (toolName === "--schema") {
    const names = JSON.parse(Buffer.from(encodedArguments, "base64url").toString("utf8"));
    const tools = await client.listTools();
    console.log(
      JSON.stringify(
        tools.tools
          .filter((tool) => names.includes(tool.name))
          .map(({ name, description, inputSchema, outputSchema }) => ({
            name,
            description,
            inputSchema,
            outputSchema,
          })),
        null,
        2,
      ),
    );
  } else {
    const args = JSON.parse(Buffer.from(encodedArguments, "base64url").toString("utf8"));
    const result = await client.callTool({ name: toolName, arguments: args });
    console.log(JSON.stringify(result, null, 2));
    if (result.isError) process.exitCode = 2;
  }
} finally {
  await client.close();
}
