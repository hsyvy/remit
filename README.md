# Remit

**Your agent spends within its remit.**

Remit is a spending wallet for AI agents, built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

1. The agent writes its own budget request, with a reason for each line.
2. You approve the request on PayPal. That puts a hold on your funds.
3. The agent can then spend only from that hold, one partial capture per purchase.
4. Anything the agent doesn't spend is released back to you. Only you can approve more money.

## Status

Planning. The product brief is in [`docs/remit-brief.html`](docs/remit-brief.html). Open it in a browser to read it.

## Planned stack

- Claude, with tool use, for the agent and its budget planning
- PayPal Orders and Payments APIs, sandbox only (authorize, partial capture, void)
- PayPal Agent Toolkit for refunds, shipment tracking and transactions
- Channel3 for product search
- An MCP server, so other agents can use the wallet

## License

[MIT](LICENSE)
