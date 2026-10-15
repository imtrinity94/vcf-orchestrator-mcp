# FAQ

**Which Orchestrator versions are supported?**
VCF Operations Orchestrator 9.x, embedded in VCF Automation 9 or standalone. It's verified on VCF Automation 9.1.1 with the embedded Orchestrator. The bundled API spec is from 9.0.0; `VRO_SPEC_PATH` lets you load a newer one.

**Does it work with Aria Automation 8.x / vRealize Orchestrator 8.x?**
Not tested. The REST API is largely the same, and the `vcfa` auth mode uses the Aria Automation 8 CSP login, but this hasn't been verified.

**Which AI clients can I use?**
Any MCP client that runs local (stdio) servers: Claude Desktop, Claude Code, Cursor, VS Code with GitHub Copilot, and others. See [[Client Configuration|Client-Configuration]].

**Does my password get stored anywhere?**
No. Setup uses it once to log in and create the service account. Only the service account's refresh token is stored, in `~/.vcf-orchestrator-mcp/tokens.json`.

**Does the AI see my credentials?**
No. The server holds the token and makes the API calls; the assistant only sees the results.

**What can it change?**
Everything the service account's roles allow: create, update, run and delete workflows and actions, and call any Orchestrator REST endpoint. It's full access by design. Start in a lab, and keep your client's tool-approval prompts on.

**How do I limit what it can do?**
Give the service account fewer roles, use a separate service account per environment, and keep tool approvals on in your client.

**How do I revoke access?**
Delete or disable the service account in **Access Control > Service Accounts**. The MCP stops working immediately.

**Can I use it on two machines?**
Yes, but run setup on each machine. Don't copy the token file; see [[Token Refresh|Token-Refresh]].

**Why does the IaaS API check in setup return 403?**
The check tests the VCF Automation IaaS API as well as Orchestrator. Depending on the roles, IaaS can return 403. Only the Orchestrator check needs to be 200.

**Why ES5?**
Orchestrator runs JavaScript on the Rhino engine. The tools and the agent skill tell the assistant to write plain ES5.

**Are versions bumped automatically?**
Yes. `vro_save_action` and `vro_save_workflow` start new items at 1.0.0 and bump the patch version on every update, unless you ask for a minor or major bump or an explicit version.

**Does it support VCF Automation itself (projects, templates, deployments)?**
Not yet; that's the next step. For now, workflows built with the MCP can call the VCF Automation APIs through the vRA plug-in, as the onboarding example does.

**Is it free?**
Yes, MIT licensed. The agent skill is free too.
