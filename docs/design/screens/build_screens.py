# Builds the ten Remit app screens in the Sky style, matching the landing page:
# a sky-blue dot-grid surface, frosted-glass chrome, paper for content, Google Sans for the interface,
# Courier Prime for typed money on paper, and the generated stamps.
import json, os, sys

OUT = sys.argv[1]
B = lambda i: "/_blob/" + i
A = {
    "sky": B("c102c5fa184d7b0df167af06aa9708b0"), "sky_tall": B("a77816783e8a5157f81784af83128307"),
    "laid": B("80f473ffb4fbe6b37da1c055afd9a865"), "cheque": B("81ef59ebb9a3c3b336f26ccad028dbb7"),
    "guilloche": B("ab23298383641ea3515e855c55010d23"), "mark": B("05d26856a6b51fdf3bde88bf8104603b"),
    "paid": B("e2e711bc9a7c9f03adb044bd965acb11"), "refused": B("7d79b23f37bac81a230590f66138e074"),
    "ask": B("998e618eb6d4ef4ab3f00b95d1b48ee9"), "approved": B("79d0662c950ac5c2878a53b61c81cae6"),
    "returned": B("c44fe921dded22014dcc55826d61d7fc"), "slip": B("4d2911b9364938f73171d5a8f893fbbc"),
    "sheet": B("7b88509de1cf320e3c64f4461de07f83"),
    "gro": B("c4d8b83594046bade69342ca7472bfbd"), "dog": B("e4ce7dc2929f38218ea0017f202ab4e7"),
    "gift": B("71458d488872717b835955b5c3bf1ea3"), "buf": B("e531e795893e3aa6608157f51ce50e6f"),
    "product": B(os.environ.get("PRODUCT_ID", "")),
}

FONTS = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,400..700'
         '&amp;family=Google+Sans+Code:wght@400;500&amp;family=Courier+Prime:wght@400;700&amp;family=Caveat:wght@500;600&amp;display=swap">')

CSS = """
body{margin:0;background:#6fa7d9}
a{color:inherit}
.r{--navy:#101e34;--t1:#0d1a2d;--t2:rgba(16,30,52,.74);--t3:rgba(16,30,52,.56);--amber:#7a4c06;--ok:#2e7650;--no:#a23a2e;--ask:#8f6312;
  --paper:#fbf9f4;--ink:#1b2433;--ink2:#4a5466;--ink3:#5f6778;--rule:rgba(27,36,51,.13);
  --fd:"Google Sans Flex","Google Sans",ui-sans-serif,system-ui,-apple-system,sans-serif;--fm:"Google Sans Code",ui-monospace,monospace;--ft:"Courier Prime","Courier New",monospace;
  --sh:0 1px 2px rgba(24,48,84,.14),0 22px 40px -22px rgba(24,58,102,.55);
  position:relative;min-height:1080px;display:flex;align-items:stretch;font-family:var(--fd);font-size:14.5px;line-height:1.5;color:var(--t1);
  background:#6fa7d9 url(SKY) center/cover no-repeat;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.r *{box-sizing:border-box}
.mono{font-family:var(--fm)}
/* frosted glass: the chrome */
.glass{background:rgba(228,240,250,.62);-webkit-backdrop-filter:blur(18px) saturate(140%);backdrop-filter:blur(18px) saturate(140%);border:1px solid rgba(255,255,255,.62);border-radius:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.75),0 20px 40px -24px rgba(24,58,102,.5)}
/* paper: the content */
.paper{position:relative;background:var(--paper) url(LAID) center/700px auto;border-radius:4px;box-shadow:var(--sh);color:var(--ink);padding:24px 26px}
.ch{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px;font:500 11.5px/1 var(--fm);letter-spacing:.14em;text-transform:uppercase;color:var(--amber)}
.k{font:400 12.5px/1.4 var(--fm);color:var(--t3)}
.paper .k{color:var(--ink3)}
.big{font:600 64px/1 var(--fd);letter-spacing:-.045em;color:var(--t1)}
.money{font-family:var(--ft);font-weight:700}
/* sidebar */
.side{flex:none;width:236px;margin:14px 0 14px 14px;padding:20px 12px 16px;display:flex;flex-direction:column;gap:2px}
.ws{display:flex;align-items:center;gap:10px;padding:4px 12px 22px;font:600 20px/1 var(--fd);letter-spacing:-.025em}
.mk{width:24px;height:24px;flex:none;background:var(--navy);-webkit-mask:url(MARK) center/contain no-repeat;mask:url(MARK) center/contain no-repeat}
.ni{display:flex;align-items:center;gap:11px;min-height:40px;padding:0 12px;border-radius:11px;font-size:14px;color:var(--t2);text-decoration:none}
.ni:hover{background:rgba(255,255,255,.45);color:var(--t1)}
.ni.on{background:rgba(255,255,255,.85);color:var(--t1);box-shadow:0 1px 2px rgba(24,48,84,.14)}
.ni svg{width:16px;height:16px;flex:none}
.count{margin-left:auto;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--navy);color:#eef5fb;font:500 11.5px/20px var(--fm);text-align:center}
.sh{margin:24px 12px 8px;font:500 11px/1 var(--fm);letter-spacing:.14em;text-transform:uppercase;color:var(--amber)}
.agent{display:flex;align-items:center;gap:10px;padding:6px 12px;font-size:14px;line-height:1.3}
.agent small{display:block;color:var(--t3);font-size:12px}
.pic{width:30px;height:30px;flex:none;border-radius:9px;display:grid;place-items:center;background:var(--navy);color:#eef5fb}
.pic svg{width:15px;height:15px}
.sfoot{margin-top:auto;padding:14px 12px 0;border-top:1px solid rgba(16,30,52,.12);font-size:12.5px;line-height:1.45;color:var(--t2)}
.sfoot b{display:block;color:var(--t1);font-weight:600;margin-bottom:2px}
/* page */
.main{flex:1;min-width:0;padding:40px 44px 56px;display:flex;flex-direction:column;gap:26px}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap}
.crumb{margin:0 0 10px;font:400 12.5px var(--fm);color:var(--t3)}
.crumb a{text-decoration:none}
.t{margin:0;font:600 38px/1.06 var(--fd);letter-spacing:-.032em;max-width:26ch;text-wrap:balance}
.sub{margin:10px 0 0;font-size:15.5px;color:var(--t2);max-width:64ch;text-wrap:pretty}
.acts-top{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
/* controls */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 18px;border-radius:10px;border:1.5px solid var(--navy);background:transparent;color:var(--navy);font:500 14.5px/1 var(--fd);text-decoration:none;cursor:pointer;white-space:nowrap}
.btn.pri{background:var(--navy);color:#eef5fb}
.btn.pri:hover{background:#1f3658}
.btn.sec:hover{background:rgba(16,30,52,.06)}
.btn.sm{min-height:36px;padding:0 14px;font-size:13.5px}
.btn.ghost{border-color:transparent}
.btn.danger{border-color:var(--no);color:var(--no)}
.chip{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 11px;border-radius:13px;background:rgba(16,30,52,.07);font:500 12.5px/1 var(--fd);color:var(--t2);white-space:nowrap}
.chip i{width:7px;height:7px;border-radius:50%;background:currentColor}
.chip.ok{color:var(--ok);background:rgba(46,118,80,.11)}
.chip.no{color:var(--no);background:rgba(162,58,46,.1)}
.chip.ask{color:var(--ask);background:rgba(143,99,18,.12)}
.chip.glass{border-radius:13px;background:rgba(255,255,255,.62);color:var(--t1)}
.top>.chip,.acts-top>.chip,.hd>.chip{box-shadow:inset 0 0 0 1px rgba(255,255,255,.7);background-color:rgba(255,255,255,.78)}
.chip.live i{background:var(--ok);box-shadow:0 0 0 3px rgba(46,118,80,.18)}
.track{height:6px;border-radius:3px;background:rgba(27,36,51,.1);overflow:hidden}
.fill{height:100%;border-radius:3px;background:var(--navy)}
.facts{list-style:none;margin:0;padding:0;border-top:1.5px solid currentColor}
.facts li{padding:12px 0;border-bottom:1px solid rgba(16,30,52,.14);font-size:14.5px;color:var(--t2)}
.paper .facts li{border-color:var(--rule);color:var(--ink2)}
.dl{margin:0}
.dl div{display:grid;grid-template-columns:150px minmax(0,1fr);gap:16px;padding:11px 0;border-bottom:1px solid var(--rule)}
.dl div:last-child{border-bottom:0}
.dl dt{font:400 12.5px/1.6 var(--fm);color:var(--ink3)}
.dl dd{margin:0}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font:500 11px/1 var(--fm);letter-spacing:.12em;text-transform:uppercase;color:var(--ink3);padding:0 12px 12px;border-bottom:1.5px solid var(--ink)}
td{padding:13px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
td small{display:block;color:var(--ink3);font-size:12.5px;line-height:1.45;margin-top:2px}
td a{text-decoration-color:rgba(27,36,51,.3);text-underline-offset:3px}
th.n,td.n{text-align:right;white-space:nowrap}
td.n{font:700 14px/1.5 var(--ft)}
tr.tot td{border-bottom:0;border-top:1.5px solid var(--ink);font-weight:600}
.x{text-decoration:line-through;color:var(--ink3)}
.stamp{position:absolute;pointer-events:none;mix-blend-mode:multiply}
"""

ICONS = {
    "week": '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"></rect><path d="M2.5 6.5h11M5.5 1.8v2.4M10.5 1.8v2.4" stroke="currentColor" stroke-width="1.3"></path></svg>',
    "req": '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v7H8.5L5.5 13v-2.5H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path></svg>',
    "ledger": '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path></svg>',
    "stmt": '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h6l2.5 2.5v8.5H4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path><path d="M6 8h4.5M6 10.5h3" stroke="currentColor" stroke-width="1.3"></path></svg>',
    "agents": '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.3"></circle><path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" fill="none" stroke="currentColor" stroke-width="1.3"></path></svg>',
}
SPARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c.5 3.2 1.8 5 5 5.6v.4c-3.2.6-4.5 2.4-5 5.5h-.4c-.5-3.1-1.8-4.9-5-5.5v-.4c3.2-.6 4.5-2.4 5-5.6z" fill="currentColor"></path></svg>'

def side(active, foot):
    items = [("week", "Main.dc.html", "This week", ""), ("req", "Topup.dc.html", "Requests", '<span class="count">1</span>'),
             ("ledger", "Ledger.dc.html", "Ledger", ""), ("stmt", "Statement.dc.html", "Statements", ""), ("agents", "Agents.dc.html", "Agents", "")]
    links = "\n    ".join(f'<a class="ni{" on" if k == active else ""}" href="{h}">{ICONS[k]}{t}{c}</a>' for k, h, t, c in items)
    return f"""<nav class="side glass" aria-label="Remit">
    <div class="ws"><span class="mk"></span>Remit</div>
    {links}
    <div class="sh">Shopping for you</div>
    <div class="agent"><span class="pic">{SPARK}</span><span>Desktop assistant<small>Connected over MCP</small></span></div>
    <div class="agent"><span class="pic">{SPARK}</span><span>Remit’s shopping agent<small>Plans each week</small></span></div>
    <div class="sfoot">{foot}</div>
  </nav>"""

FOOT_HELD = "<b>Household</b>$176.50 held on PayPal since Sun, Nov 8. What’s left is released on Sun, Nov 15."

def page(name, title, body, extra="", w=1440, h=1080):
    css = (CSS + extra).replace("SKY", A["sky_tall"] if w < 600 else A["sky"]).replace("LAID", A["laid"]).replace("MARK", A["mark"])
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Remit, {title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
{FONTS}
<style>{css}</style>
</helmet>
{body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{json.dumps({"$preview": {"width": w, "height": h}}, separators=(",", ":"))}'>
class Component extends DCLogic {{
  renderVals() {{
    return {{}};
  }}
}}
</script>
</body>
</html>
"""
    open(os.path.join(OUT, name + ".dc.html"), "w").write(html)

# ---------------------------------------------------------------- This week
page("Main", "this week", f"""<div class="r">
  {side("week", FOOT_HELD)}
  <main class="main">
    <div class="top">
      <div>
        <h1 class="t">This week</h1>
        <p class="sub">Nov 9 – 15. Your agent planned it from your last four weeks, and you approved it on Sunday.</p>
      </div>
      <div class="acts-top"><span class="chip glass live"><i></i>Hold active on PayPal</span><a class="btn sec sm" href="Statement.dc.html">Close the week</a></div>
    </div>

    <section class="purse glass" aria-label="Balance">
      <div>
        <div class="k">Left to spend</div>
        <div class="big">$55.20</div>
        <div class="k">of $176.50 held on PayPal</div>
      </div>
      <div class="stats">
        <div><div class="k">Captured</div><div class="v">$121.30</div></div>
        <div><div class="k">Refused</div><div class="v">1</div></div>
        <div><div class="k">Waiting for you</div><div class="v amber">$104.50</div></div>
      </div>
    </section>

    <section class="askrow paper" aria-label="Request waiting for you">
      <img src="{A['ask']}" alt="Ask you">
      <p>Your agent is asking for $104.50 more for Sam’s gift.<span>The gift you picked is $144.50 with wrapping. Its line has $40.00.</span></p>
      <a class="btn pri sm" href="Topup.dc.html">Review request</a>
    </section>

    <div class="grid">
      <section class="paper" aria-label="Lines">
        <div class="ch">Lines</div>
        <div class="ln"><img src="{A['gro']}" alt=""><b>Groceries</b><span class="amt"><b class="money">$1.20</b> left of $88.00</span><small>Two orders. Your last four weeks averaged $41.80 an order.</small><div class="track"><div class="fill" style="width:98.6%"></div></div></div>
        <div class="ln"><img src="{A['dog']}" alt=""><b>Dog food</b><span class="amt"><b class="money">$0.00</b> left of $32.50</span><small>The 12 kg bag runs out on Thursday.</small><div class="track"><div class="fill" style="width:100%"></div></div></div>
        <div class="ln"><img src="{A['gift']}" alt=""><b>Gift for Sam</b><span class="amt"><b class="money">$40.00</b> left of $40.00</span><small>Birthday on the 14th. You said about $40.</small><div class="track"><div class="fill" style="width:0%"></div></div></div>
        <div class="ln"><img src="{A['buf']}" alt=""><b>Shared buffer</b><span class="amt"><b class="money">$14.00</b> left of $16.00</span><small>Price changes and delivery. Any line can use it.</small><div class="track"><div class="fill" style="width:12.5%"></div></div></div>
      </section>

      <section class="paper" aria-label="Activity">
        <div class="ch">Activity</div>
        <ol class="rows">
          <li><div class="row"><div class="tt">Delivery fee</div><div class="m"><span>Fri 09:13</span>Shared buffer</div><span class="a money">$2.00</span><img src="{A['paid']}" alt="Paid"></div></li>
          <li><div class="row"><div class="tt">Grocery order</div><div class="m"><span>Fri 09:12</span>Groceries</div><span class="a money">$43.40</span><img src="{A['paid']}" alt="Paid"></div></li>
          <li><a class="row" href="Topup.dc.html"><div class="tt">Top-up for Sam’s gift</div><div class="m"><span>Thu 16:30</span>Gift for Sam</div><span class="a money">$104.50</span><img src="{A['ask']}" alt="Waiting for you"></a></li>
          <li><a class="row" href="Purchase.dc.html"><div class="tt">Phone case</div><div class="m"><span>Thu 14:15</span>Tried Groceries</div><span class="a money x">$18.99</span><img src="{A['refused']}" alt="Refused"></a></li>
          <li><div class="row"><div class="tt">Grocery order</div><div class="m"><span>Tue 11:40</span>Groceries</div><span class="a money">$43.40</span><img src="{A['paid']}" alt="Paid"></div></li>
          <li><div class="row"><div class="tt">Dog food, 12 kg bag</div><div class="m"><span>Tue 10:02</span>Dog food</div><span class="a money">$32.50</span><img src="{A['paid']}" alt="Paid"></div></li>
          <li><a class="row" href="Plan.dc.html"><div class="tt">You approved the plan</div><div class="m"><span>Sun 21:14</span>Hold placed on PayPal</div><span class="a money">$176.50</span><img src="{A['approved']}" alt="Approved"></a></li>
        </ol>
      </section>
    </div>
  </main>
</div>""", """
.purse{display:flex;align-items:flex-end;justify-content:space-between;gap:32px;padding:26px 30px;flex-wrap:wrap}
.purse .big{margin:8px 0}
.stats{display:flex;gap:0}
.stats>div{padding:0 28px;border-left:1px solid rgba(16,30,52,.14)}
.stats .v{margin-top:6px;font:600 26px/1 var(--fd);letter-spacing:-.03em}
.v.amber{color:var(--amber)}
.askrow{display:flex;align-items:center;gap:20px;padding:14px 22px 14px 18px}
.askrow img{width:96px;transform:rotate(-6deg);mix-blend-mode:multiply}
.askrow p{flex:1;margin:0;font-weight:600;font-size:15px}
.askrow p span{display:block;font-weight:400;color:var(--ink2);font-size:14px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:22px;align-items:start}
.ln{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:2px 16px;align-items:center;padding:12px 0;border-top:1px solid var(--rule)}
.ln:first-of-type{border-top:0;padding-top:0}
.ln img{grid-row:1/4;width:52px;filter:drop-shadow(0 3px 4px rgba(24,48,84,.25))}
.ln>b{font-weight:600;font-size:15px}
.ln .amt{font-size:13px;color:var(--ink3)}
.ln .amt b{font-size:15px;color:var(--ink)}
.ln small{grid-column:2/4;color:var(--ink3);font-size:12.5px}
.ln .track{grid-column:2/4;margin-top:6px}
.rows{list-style:none;margin:0;padding:0}
.rows li+li{border-top:1px solid var(--rule)}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto 72px;grid-template-rows:auto auto;gap:0 16px;align-items:center;padding:9px 0;text-decoration:none;color:inherit}
.row .tt{font-weight:600}
.row .m{grid-row:2;font-size:12.5px;color:var(--ink3)}
.row .m span{font-family:var(--fm);margin-right:8px}
.row .a{grid-row:1/3;grid-column:2;font-size:15px}
.row img{grid-row:1/3;grid-column:3;width:72px;transform:rotate(-5deg);mix-blend-mode:multiply}
a.row:hover .tt{text-decoration:underline;text-underline-offset:3px}
""")

# ---------------------------------------------------------------- Set up
page("Setup", "set up", f"""<div class="r setup">
  <header class="bar glass">
    <div class="ws"><span class="mk"></span>Remit</div>
    <span class="k">Step 2 of 3</span>
  </header>
  <main class="wrapc">
    <h1 class="t">Set up a wallet your agent can’t overspend.</h1>
    <p class="sub">Three steps. Nothing is held or spent until you approve a plan, and you can disconnect at any time.</p>
    <ol class="steps">
      <li class="step paper">
        <span class="n">1</span>
        <h2>Connect PayPal</h2>
        <img class="done" src="{A['paid']}" alt="Done">
        <p>Remit places holds on your PayPal account when you approve a plan. It never sees your card or bank details.</p>
      </li>
      <li class="step paper">
        <span class="n">2</span>
        <h2>Connect your agent</h2>
        <span class="chip ask st"><i></i>Waiting for the agent</span>
        <p>Add Remit to the agent you already use. It gets four tools and a token, and no access to PayPal.</p>
        <div class="more">
          <div class="tabs" role="group" aria-label="How to connect">
            <button class="tab on" type="button" aria-pressed="true">MCP config</button>
            <button class="tab" type="button" aria-pressed="false">Command line</button>
            <button class="tab" type="button" aria-pressed="false">Remit’s own agent</button>
          </div>
<pre><span class="k2">"remit"</span>: {{
  <span class="k2">"command"</span>: <span class="s">"npx"</span>,
  <span class="k2">"args"</span>: [<span class="s">"remit-mcp"</span>],
  <span class="k2">"env"</span>: {{ <span class="k2">"REMIT_AGENT_TOKEN"</span>: <span class="s">"remit_agt_7Qx…3f9c"</span> }}
}}</pre>
          <div class="field">
            <label for="tok">Agent token</label>
            <div class="tok"><input id="tok" type="text" value="remit_agt_7Qx…3f9c" readonly><button class="btn sec" type="button">Copy</button></div>
          </div>
          <p class="wait">Remit moves on as soon as the agent calls <b>get_balance</b>.</p>
        </div>
      </li>
      <li class="step paper later">
        <span class="n">3</span>
        <h2>Ask for a first plan</h2>
        <p>Your agent looks at what you usually buy and proposes a budget with a reason for every line. You review it, change it, and approve it on PayPal.</p>
      </li>
    </ol>
    <p class="foot">Already set up? <a href="Plan.dc.html">See a plan waiting for review</a></p>
  </main>
</div>""", """
.setup{display:block}
.bar{display:flex;align-items:center;justify-content:space-between;max-width:1040px;margin:14px auto 0;height:58px;padding:0 20px 0 8px}
.bar .ws{padding:0 12px}
.wrapc{max-width:760px;margin:0 auto;padding:40px 24px 48px}
.wrapc .t{font-size:46px;max-width:16ch;letter-spacing:-.038em}
.wrapc .sub{font-size:17px}
.steps{list-style:none;margin:40px 0 0;padding:0;display:flex;flex-direction:column;gap:16px}
.step{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:4px 16px;align-items:start}
.step.later{opacity:.66}
.n{font:500 16px/1.5 var(--fm);color:var(--ink3)}
.step h2{margin:0;font:600 19px/1.4 var(--fd);letter-spacing:-.015em}
.step>p{margin:4px 0 0;grid-column:2;color:var(--ink2)}
.st{grid-row:1;grid-column:3}
.done{width:84px;transform:rotate(-7deg);grid-row:1/3;grid-column:3;align-self:center;mix-blend-mode:multiply}
.more{grid-column:2/-1;margin-top:18px;display:flex;flex-direction:column;gap:14px}
.tabs{display:inline-flex;gap:2px;padding:3px;border-radius:11px;background:rgba(27,36,51,.07);width:fit-content}
.tab{border:0;border-radius:8px;background:transparent;color:var(--ink2);font:500 13.5px var(--fd);min-height:34px;padding:0 14px;cursor:pointer}
.tab.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(24,48,84,.18)}
pre{margin:0;padding:16px 18px;border-radius:10px;background:#101e34;color:#9fb0c6;font:13px/1.7 var(--fm);overflow-x:auto}
pre .k2{color:#eef5fb}pre .s{color:#a9cdeb}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font:400 12.5px var(--fm);color:var(--ink3)}
.tok{display:flex;gap:8px;flex-wrap:wrap}
.tok input{flex:1 1 260px;min-height:44px;padding:0 12px;border-radius:10px;border:1.5px solid rgba(27,36,51,.24);background:#fff;color:var(--ink);font:14px var(--fm)}
.wait{margin:0;font-size:14px;color:var(--ink2)}
.wait b{font-family:var(--fm);font-weight:500}
.foot{margin-top:28px;font-size:14.5px;color:var(--t2)}
""")

# ---------------------------------------------------------------- Review a plan
page("Plan", "review a plan", f"""<div class="r">
  {side("req", "<b>No hold yet</b>Nothing is held on PayPal until you approve a plan.")}
  <main class="main">
    <div>
      <p class="crumb"><a href="Main.dc.html">Requests</a> / Plan for Nov 9 – 15</p>
      <h1 class="t">Your agent is asking for $176.50 for Nov 9 – 15</h1>
      <p class="sub">Read each reason. Change an amount or strike a line before you approve. Nothing is taken until your agent buys something.</p>
    </div>
    <div class="grid">
      <div class="ledger">
        <div class="lines">
          <div class="lrow"><b>Budget request</b><span class="dots"></span><b>Nov 9 – 15</b></div>
          <div>&nbsp;</div>
          <div class="lrow"><span>Groceries, 2 orders</span><span class="dots"></span><span class="amt">$<input aria-label="Groceries amount" value="88.00"></span><button class="x2" type="button" aria-label="Remove Groceries">×</button></div>
          <div class="why">Averaged $41.80 an order. Prices up 4%.</div>
          <div class="lrow"><span>Dog food, 12 kg bag</span><span class="dots"></span><span class="amt">$<input aria-label="Dog food amount" value="32.50"></span><button class="x2" type="button" aria-label="Remove Dog food">×</button></div>
          <div class="why">The bag from Oct 19 runs out on Thursday.</div>
          <div class="lrow"><span>Birthday gift for Sam</span><span class="dots"></span><span class="amt">$<input aria-label="Gift amount" value="40.00"></span><button class="x2" type="button" aria-label="Remove Gift for Sam">×</button></div>
          <div class="why">You asked for about $40, for the 14th.</div>
          <div class="lrow"><span>Shared buffer</span><span class="dots"></span><span class="amt">$<input aria-label="Buffer amount" value="16.00"></span><button class="x2" type="button" aria-label="Remove Shared buffer">×</button></div>
          <div class="why">About 10% for price changes and delivery.</div>
          <div>&nbsp;</div>
          <div class="lrow"><b>Total</b><span class="dots"></span><b>$176.50</b></div>
          <div>&nbsp;</div>
          <div class="hand">Prepared by your agent, Sun 20:52</div>
        </div>
      </div>
      <aside class="approve glass" aria-label="Approve">
        <div>
          <div class="k">You’re approving</div>
          <div class="big" style="margin-top:10px">$176.50</div>
        </div>
        <ul class="facts">
          <li>PayPal holds $176.50. It stays in your account.</li>
          <li>Your agent can spend only from these four lines, one purchase at a time.</li>
          <li>Each purchase is checked against its line before money moves.</li>
          <li>Whatever is left on Sun, Nov 15 is released to you.</li>
        </ul>
        <div class="acts">
          <a class="btn pri" href="Main.dc.html">Approve $176.50 on PayPal</a>
          <button class="btn sec" type="button">Ask your agent to revise</button>
          <button class="btn ghost" type="button">Decline</button>
        </div>
      </aside>
    </div>
  </main>
</div>""", f"""
.grid{{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(300px,.85fr);gap:44px;align-items:start}}
.ledger{{position:relative;container-type:inline-size;max-width:640px;width:100%;aspect-ratio:880/820;background:url({A['sheet']}) center/100% 100% no-repeat;transform:rotate(-.8deg);filter:drop-shadow(0 26px 30px rgba(24,58,102,.35)) drop-shadow(0 2px 3px rgba(24,48,84,.3));color:#20283a}}
.lines{{position:absolute;left:12.5%;right:5%;top:10.4cqw;font:400 3cqw/4.773cqw var(--ft)}}
.lines>div{{height:4.773cqw;white-space:nowrap;overflow:hidden}}
.lrow{{display:flex;gap:1.4cqw;align-items:baseline}}
.lrow .dots{{flex:1;border-bottom:.3cqw dotted rgba(27,36,51,.35);transform:translateY(-1cqw)}}
.lrow b{{font-weight:700}}
.why{{color:#5a6273;font-size:2.45cqw}}
.amt{{display:inline-flex;align-items:baseline}}
.amt input{{width:13cqw;border:0;border-bottom:.25cqw solid rgba(27,36,51,.45);background:transparent;font:700 3cqw var(--ft);color:#20283a;text-align:right;padding:0;outline:none}}
.x2{{border:0;background:transparent;color:#8a5a52;font:700 3cqw var(--ft);cursor:pointer;padding:0 0 0 1.4cqw}}
.hand{{font:600 4.4cqw/4.773cqw "Caveat",cursive;color:#1f4f8c;transform:rotate(-2deg);transform-origin:left}}
.approve{{display:flex;flex-direction:column;gap:20px;padding:26px}}
.acts{{display:flex;flex-direction:column;gap:10px}}
""")

# ---------------------------------------------------------------- A refused purchase
page("Purchase", "a refused purchase", f"""<div class="r">
  {side("ledger", FOOT_HELD)}
  <main class="main">
    <div class="top">
      <div>
        <p class="crumb"><a href="Ledger.dc.html">Ledger</a> / Phone case</p>
        <h1 class="t">Phone case, $18.99</h1>
        <p class="sub">Thu, Nov 12 at 14:15. Your agent tried to pay for it from Groceries. Nothing was taken from your hold.</p>
      </div>
      <span class="chip no"><i></i>Refused</span>
    </div>
    <div class="grid">
      <section class="paper" aria-label="Checks">
        <img class="stamp" src="{A['refused']}" alt="" style="right:22px;top:14px;width:150px;transform:rotate(8deg)">
        <div class="ch">The four checks</div>
        <ol class="checks">
          <li class="ck"><span class="ic pass"></span><b>The line is in your plan</b><p>Groceries is an approved line this week.</p></li>
          <li class="ck"><span class="ic pass"></span><b>It fits what’s left</b><p>$18.99 fits the $44.60 left on Groceries.</p></li>
          <li class="ck"><span class="ic fail"></span><b>Purpose check</b><p>A separate model compared the purchase with the line. It didn’t see the page your agent was shopping on.</p>
            <div class="quote"><span>Purpose check, 14:15:06</span>The Groceries line was approved for food and household groceries, two orders a week. A clear phone case is an accessory, not groceries. <strong>Refuse.</strong></div></li>
          <li class="ck skip"><span class="ic">4</span><b>Capture from your PayPal hold</b><p>Not reached.</p></li>
        </ol>
      </section>
      <div class="stack">
        <section class="paper" aria-label="The request">
          <div class="ch">What your agent asked to buy</div>
          <dl class="dl">
            <div><dt>Item</dt><dd>Phone case, clear</dd></div>
            <div><dt>Store</dt><dd>Accessories shop</dd></div>
            <div><dt>Line</dt><dd>Groceries</dd></div>
            <div><dt>Price</dt><dd><span class="money">$18.99</span> with shipping</dd></div>
            <div><dt>Agent’s reason</dt><dd>Your case is cracked. This one fits your phone and is under $20.</dd></div>
          </dl>
        </section>
        <section class="glass next" aria-label="What happens next">
          <div class="ch">What happens next</div>
          <p>Your agent was told why, and that it can’t try another line. If you want the case, add it to the plan. That’s a new approval on PayPal.</p>
          <div class="row2"><a class="btn sec" href="Topup.dc.html">Add a line for it</a><a class="btn ghost" href="Main.dc.html">Leave it refused</a></div>
        </section>
      </div>
    </div>
  </main>
</div>""", """
.grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:22px;align-items:start}
.stack{display:flex;flex-direction:column;gap:22px}
.checks{list-style:none;margin:0;padding:0}
.ck{display:grid;grid-template-columns:28px minmax(0,1fr);gap:2px 14px;padding:16px 0;border-top:1px solid var(--rule)}
.ck:first-child{border-top:0;padding-top:4px}
.ck b{font-weight:600;font-size:15px}
.ck p{grid-column:2;margin:0;color:var(--ink2)}
.ic{grid-row:1/3;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;border:1.5px solid var(--ink3);font:500 12px var(--fm);color:var(--ink3)}
.ic.pass{border-color:var(--ok);background:var(--ok)}
.ic.pass::after{content:"";width:9px;height:5px;border:2px solid #fff;border-top:0;border-right:0;transform:translateY(-1px) rotate(-45deg)}
.ic.fail{border-color:var(--no);background:var(--no)}
.ic.fail::after{content:"×";color:#fff;font:700 15px/1 var(--fd)}
.ck.skip{opacity:.55}
.quote{grid-column:2;margin-top:12px;padding:14px 16px;border-left:3px solid var(--no);background:rgba(162,58,46,.06);font:400 13.5px/1.6 var(--ft);color:var(--ink)}
.quote span{display:block;margin-bottom:6px;font:400 12px var(--fm);color:var(--ink3)}
.next{padding:24px 26px}
.next p{margin:0;color:var(--t2)}
.row2{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
""")

# ---------------------------------------------------------------- Top-up request
page("Topup", "top-up request", f"""<div class="r">
  {side("req", FOOT_HELD)}
  <main class="main">
    <div class="top">
      <div>
        <p class="crumb"><a href="Main.dc.html">Requests</a> / Top-up</p>
        <h1 class="t">Approve $104.50 more for Sam’s gift?</h1>
        <p class="sub">Your agent asked on Thu, Nov 12 at 16:30, after finding a gift that costs more than the line allows.</p>
      </div>
      <span class="chip ask"><i></i>Waiting for you</span>
    </div>
    <div class="grid">
      <section class="paper" aria-label="The gift">
        <img class="stamp" src="{A['ask']}" alt="" style="right:20px;top:14px;width:130px;transform:rotate(7deg)">
        <div class="ch">What it’s for</div>
        <div class="prod">
          <img src="{A['product']}" alt="Watercolor travel set in an open tin">
          <div><h2>Watercolor travel set, 24 colors</h2><p>Gift shop, with gift wrapping. Arrives Fri, Nov 13.</p><div class="price money">$144.50</div></div>
        </div>
        <div class="why"><span>Agent’s reason</span>Sam mentioned wanting to paint on trips. This set has the best reviews of the ones that arrive before the 14th. It costs $144.50 with wrapping, and the Gift for Sam line has $40.00.</div>
        <div class="sum">
          <div><span>Gift for Sam now</span><span class="money">$40.00</span></div>
          <div><span>Top-up</span><span class="money">+ $104.50</span></div>
          <div class="tot"><span>Gift for Sam after</span><span class="money">$144.50</span></div>
        </div>
      </section>
      <aside class="approve glass" aria-label="Approve">
        <div><div class="k">You’re approving</div><div class="big" style="margin-top:10px">$104.50</div></div>
        <ul class="facts">
          <li>PayPal places a second hold of $104.50.</li>
          <li>It adds to Gift for Sam only. Your other lines don’t change.</li>
          <li>Purchases take from the oldest hold first. Anything unspent is released on Nov 15.</li>
        </ul>
        <div class="acts">
          <a class="btn pri" href="Statement.dc.html">Approve $104.50 on PayPal</a>
          <a class="btn sec" href="Main.dc.html">Decline</a>
        </div>
        <div class="other">
          <label for="amt">Or approve a different amount</label>
          <div class="in"><div class="box"><span>$</span><input id="amt" type="text" inputmode="decimal" placeholder="60.00"></div><button class="btn sec" type="button">Approve</button></div>
        </div>
      </aside>
    </div>
  </main>
</div>""", """
.grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(320px,.8fr);gap:22px;align-items:start}
.prod{display:grid;grid-template-columns:180px minmax(0,1fr);gap:22px;align-items:center}
.prod img{width:180px;aspect-ratio:1;object-fit:cover;border-radius:6px;box-shadow:0 1px 2px rgba(24,48,84,.2)}
.prod h2{margin:0;font:600 21px/1.25 var(--fd);letter-spacing:-.02em}
.prod p{margin:6px 0 0;color:var(--ink2)}
.price{margin-top:12px;font-size:22px}
.why{margin-top:22px;padding:16px 18px;border-left:3px solid var(--ask);background:rgba(143,99,18,.07);font:400 13.5px/1.6 var(--ft)}
.why span{display:block;margin-bottom:6px;font:400 12px var(--fm);color:var(--ink3)}
.sum{margin-top:22px;border-top:1.5px solid var(--ink)}
.sum div{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--rule)}
.sum .tot{border-bottom:0;font-weight:600}
.approve{display:flex;flex-direction:column;gap:20px;padding:26px}
.acts{display:flex;flex-direction:column;gap:10px}
.other{padding-top:16px;border-top:1px solid rgba(16,30,52,.14)}
.other label{display:block;margin-bottom:8px;font:400 12.5px var(--fm);color:var(--t3)}
.in{display:flex;gap:8px}
.box{flex:1;display:flex;align-items:center;gap:6px;min-height:44px;padding:0 12px;border-radius:10px;border:1.5px solid rgba(16,30,52,.24);background:rgba(255,255,255,.75)}
.box input{flex:1;min-width:0;border:0;background:transparent;font:700 15px var(--ft);color:var(--t1);outline:none}
""")

# ---------------------------------------------------------------- Ledger
def lrow(when, what, note, line, store, amt, chip, cls="", link=None, x=False):
    w = f'<a href="{link}"><b>{what}</b></a>' if link else f"<b>{what}</b>"
    return f'<tr class="{cls}"><td class="w">{when}</td><td>{w}<small>{note}</small></td><td>{line}</td><td>{store}</td><td class="n{" x" if x else ""}">{amt}</td><td>{chip}</td></tr>'
C = lambda c, t: f'<span class="chip {c}"><i></i>{t}</span>'
rows = "\n          ".join([
    lrow("Sun 23:59", "The week closed", "Hold 2 had $15.20 left. PayPal won’t void a hold after a partial capture, so it lapses when the authorization expires.", "All lines", "", "$15.20", C("", "Released"), "sys"),
    lrow("Fri 18:20", "Watercolor travel set, 24 colors", "Sam mentioned wanting to paint on trips. Wrapped, arrives Friday.", "Gift for Sam", "Gift shop", "$144.50", C("ok", "Paid")),
    lrow("Fri 09:13", "Delivery fee", "Fee on the second grocery order.", "Shared buffer", "Grocery delivery", "$2.00", C("ok", "Paid")),
    lrow("Fri 09:12", "Grocery order", "Second order of the week, same list.", "Groceries", "Grocery delivery", "$43.40", C("ok", "Paid")),
    lrow("Thu 19:05", "You approved a top-up", "A second hold, for Gift for Sam only.", "Gift for Sam", "", "$104.50", C("", "Hold placed"), "sys"),
    lrow("Thu 16:30", "Your agent asked for a top-up", "The gift is $144.50 with wrapping. The line has $40.00.", "Gift for Sam", "", "$104.50", C("ask", "Asked")),
    lrow("Thu 14:15", "Phone case, clear", "Purpose check: a phone case isn’t groceries.", "Groceries", "Accessories shop", "$18.99", C("no", "Refused"), link="Purchase.dc.html", x=True),
    lrow("Tue 11:40", "Grocery order", "First order of the week, from your usual list.", "Groceries", "Grocery delivery", "$43.40", C("ok", "Paid")),
    lrow("Tue 10:02", "Dog food, 12 kg bag", "Same bag as the last three orders. Runs out Thursday.", "Dog food", "Pet supply store", "$32.50", C("ok", "Paid")),
    lrow("Sun 21:14", "You approved the plan", "Four lines, based on your last four weeks.", "All lines", "", "$176.50", C("", "Hold placed"), "sys", link="Plan.dc.html"),
])
page("Ledger", "ledger", f"""<div class="r">
  {side("ledger", FOOT_HELD)}
  <main class="main">
    <div class="top">
      <div>
        <h1 class="t">Ledger</h1>
        <p class="sub">Every plan, purchase, refusal and top-up, with your agent’s reasoning. Nothing is removed from it.</p>
      </div>
      <button class="btn sec sm" type="button">Export CSV</button>
    </div>
    <div class="bar">
      <div class="seg glass" role="group" aria-label="Show">
        <button class="on" type="button" aria-pressed="true">All<span>10</span></button>
        <button type="button" aria-pressed="false">Paid<span>5</span></button>
        <button type="button" aria-pressed="false">Refused<span>1</span></button>
        <button type="button" aria-pressed="false">Approvals<span>3</span></button>
      </div>
      <div class="sel glass"><label for="wk">Period</label><select id="wk"><option>Nov 9 – 15</option><option>Nov 2 – 8</option><option>Oct 26 – Nov 1</option></select></div>
    </div>
    <section class="paper" aria-label="Ledger entries">
      <table>
        <thead><tr><th style="width:92px">When</th><th>What</th><th>Line</th><th>Store</th><th class="n">Amount</th><th style="width:118px">Status</th></tr></thead>
        <tbody>
          {rows}
        </tbody>
      </table>
    </section>
    <div class="totals glass"><span>Approved <b class="money">$281.00</b></span><span>Paid <b class="money">$265.80</b></span><span>Refused <b class="money">$18.99</b></span><span>Released <b class="money">$15.20</b></span></div>
  </main>
</div>""", """
.main{gap:20px}
.bar{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.seg{display:inline-flex;gap:2px;padding:4px;border-radius:13px}
.seg button{display:inline-flex;align-items:center;gap:8px;min-height:34px;padding:0 14px;border:0;border-radius:9px;background:transparent;color:var(--t2);font:500 13.5px var(--fd);cursor:pointer}
.seg button span{font:400 12px var(--fm);color:var(--t3)}
.seg button.on{background:#fff;color:var(--t1);box-shadow:0 1px 2px rgba(24,48,84,.16)}
.sel{display:flex;align-items:center;gap:10px;padding:4px 6px 4px 14px;border-radius:13px}
.sel label{font:400 12.5px var(--fm);color:var(--t3)}
.sel select{min-height:34px;border:0;border-radius:9px;background:#fff;padding:0 10px;font:500 13.5px var(--fd);color:var(--t1)}
.paper{padding:20px 22px 8px}
td{padding:11px 12px}
td.w{font:400 12.5px/1.7 var(--fm);color:var(--ink3);white-space:nowrap}
tr.sys td{background:rgba(27,36,51,.03)}
tbody tr:last-child td{border-bottom:0}
.totals{display:flex;gap:34px;padding:14px 22px;font-size:13.5px;color:var(--t2);border-radius:14px}
.totals b{margin-left:6px;color:var(--t1)}
""")

# ---------------------------------------------------------------- Statement
page("Statement", "statement", f"""<div class="r">
  {side("stmt", "<b>Week closed</b>$15.20 of the top-up hold is released when its authorization expires.")}
  <main class="main">
    <div class="top">
      <div>
        <p class="crumb"><a href="Statement.dc.html">Statements</a> / Nov 9 – 15</p>
        <h1 class="t">Statement for Nov 9 – 15</h1>
        <p class="sub">Closed Sun, Nov 15 at 23:59. Two holds, five purchases, one refusal.</p>
      </div>
      <div class="acts-top"><span class="chip glass"><i></i>Closed</span><button class="btn sec sm" type="button">Download PDF</button></div>
    </div>
    <div class="figs">
      <div class="fig glass"><div class="k">Approved by you</div><div class="v">$281.00</div><div class="d">The plan, plus one top-up</div></div>
      <div class="fig glass"><div class="k">Spent</div><div class="v">$265.80</div><div class="d">Five purchases, every one inside its line</div></div>
      <div class="fig glass"><div class="k">Returned to you</div><div class="v">$15.20</div><div class="d">Never left your PayPal account</div></div>
    </div>
    <section class="paper cheque" aria-label="By line">
      <img class="stamp" src="{A['returned']}" alt="" style="right:26px;top:12px;width:150px;transform:rotate(-6deg)">
      <div class="ch">By line</div>
      <table>
        <thead><tr><th>Line</th><th class="n">Approved</th><th class="n">Spent</th><th class="n">Returned</th><th style="width:24%">Used</th></tr></thead>
        <tbody>
          <tr><td>Groceries<small>Two orders</small></td><td class="n">$88.00</td><td class="n">$86.80</td><td class="n">$1.20</td><td><div class="track"><div class="fill" style="width:98.6%"></div></div></td></tr>
          <tr><td>Dog food<small>One 12 kg bag</small></td><td class="n">$32.50</td><td class="n">$32.50</td><td class="n">$0.00</td><td><div class="track"><div class="fill" style="width:100%"></div></div></td></tr>
          <tr><td>Gift for Sam<small>$40.00 in the plan, $104.50 top-up</small></td><td class="n">$144.50</td><td class="n">$144.50</td><td class="n">$0.00</td><td><div class="track"><div class="fill" style="width:100%"></div></div></td></tr>
          <tr><td>Shared buffer<small>One delivery fee</small></td><td class="n">$16.00</td><td class="n">$2.00</td><td class="n">$14.00</td><td><div class="track"><div class="fill" style="width:12.5%"></div></div></td></tr>
          <tr class="tot"><td>Total</td><td class="n">$281.00</td><td class="n">$265.80</td><td class="n">$15.20</td><td></td></tr>
        </tbody>
      </table>
    </section>
    <div class="two">
      <section class="paper" aria-label="Holds on PayPal">
        <div class="ch">Holds on PayPal</div>
        <table>
          <thead><tr><th>Hold</th><th class="n">Authorized</th><th class="n">Captured</th><th class="n">Released</th></tr></thead>
          <tbody>
            <tr><td>The plan<small>Sun, Nov 8, 21:14</small></td><td class="n">$176.50</td><td class="n">$176.50</td><td class="n">$0.00</td></tr>
            <tr><td>Top-up for Sam’s gift<small>Thu, Nov 12, 19:05</small></td><td class="n">$104.50</td><td class="n">$89.30</td><td class="n">$15.20</td></tr>
          </tbody>
        </table>
      </section>
      <section class="paper" aria-label="Refused and declined">
        <div class="ch">Refused and declined</div>
        <div class="ref"><a href="Purchase.dc.html">Phone case, from Groceries</a><span class="money x">$18.99</span></div>
        <div class="ref"><span style="color:var(--ink3)">Declined requests</span><span>None</span></div>
      </section>
    </div>
    <p class="fine">Purchases take from the oldest hold first, so the gift used the last $55.20 of the plan’s hold and $89.30 of the top-up. PayPal won’t void a hold after a partial capture (<code>PREVIOUSLY_CAPTURED</code>), so the top-up’s last $15.20 is released when its authorization expires.</p>
  </main>
</div>""", f"""
.main{{gap:20px}}
.figs{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}}
.fig{{padding:20px 22px;border-radius:16px}}
.fig .v{{margin:10px 0 4px;font:600 34px/1 var(--fd);letter-spacing:-.035em}}
.fig .d{{font-size:13px;color:var(--t2)}}
.cheque{{background:#f3efe6 url({A['cheque']}) center/900px auto;overflow:hidden;padding:20px 24px 10px}}
.paper{{padding:20px 24px 10px}}
td{{padding:10px 12px}}
.two{{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,.7fr);gap:20px;align-items:start}}
.ref{{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--rule)}}
.ref:last-child{{border-bottom:0}}
.fine{{margin:0;max-width:92ch;font-size:13px;color:var(--t2)}}
.fine code{{font:400 12px var(--fm)}}
""")

# ---------------------------------------------------------------- Agents
page("Agents", "agents", f"""<div class="r">
  {side("agents", FOOT_HELD)}
  <main class="main">
    <div class="top">
      <div>
        <h1 class="t">Agents</h1>
        <p class="sub">The agents that can spend from your plans. They never see your PayPal account, and none of them can approve money.</p>
      </div>
      <a class="btn sec sm" href="Setup.dc.html">Connect another agent</a>
    </div>
    <section class="paper list" aria-label="Connected agents">
      <div class="ag"><span class="pic">{SPARK}</span><div><h2>Desktop assistant</h2><p>Over MCP. Last call: <span class="mono">spend</span>, Fri 18:20</p></div><div class="acts"><span class="chip ok"><i></i>Connected</span><button class="btn danger sm" type="button">Disconnect</button></div></div>
      <div class="ag"><span class="pic">{SPARK}</span><div><h2>Remit’s shopping agent</h2><p>Built in. Plans each week from your history.</p></div><div class="acts"><span class="chip ok"><i></i>On</span><button class="btn sec sm" type="button">Turn off</button></div></div>
    </section>
    <div class="grid">
      <section class="paper" aria-label="What the desktop assistant can do">
        <div class="ch">What the desktop assistant can do</div>
        <div class="tool"><label for="t1">get_balance</label><p>See each line, what’s left, and anything waiting for you.</p><input id="t1" type="checkbox" checked></div>
        <div class="tool"><label for="t2">request_budget</label><p>Propose a plan of up to 28 days for you to approve.</p><input id="t2" type="checkbox" checked></div>
        <div class="tool"><label for="t3">request_topup</label><p>Ask you for more money. Each one is a new approval on PayPal.</p><input id="t3" type="checkbox" checked></div>
        <div class="tool"><label for="t4">spend</label><p>Pay for one purchase from one line, after the four checks.</p><input id="t4" type="checkbox" checked></div>
      </section>
      <div class="stack">
        <section class="glass pad" aria-label="Token">
          <div class="ch">Agent token</div>
          <label class="k" for="tk">Used by the desktop assistant</label>
          <div class="tokrow"><input id="tk" type="text" value="remit_agt_••••••••••3f9c" readonly><button class="btn sec" type="button">Rotate</button></div>
          <p class="note">Rotating disconnects every agent using this token until you paste the new one.</p>
        </section>
        <section class="paper cheque" aria-label="Fixed rules">
          <div class="ch">Rules no agent can change<span class="chip">Set in code</span></div>
          <ul class="rules">
            <li><b>Only you approve money</b>Plans and top-ups open only after you approve them on PayPal.</li>
            <li><b>Lines stay separate</b>A purchase uses its own line, then the shared buffer. Never another line.</li>
            <li><b>The purpose check must answer</b>If it can’t be reached, the purchase is refused.</li>
          </ul>
        </section>
      </div>
    </div>
  </main>
</div>""", f"""
.list{{padding:6px 26px}}
.ag{{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:16px;align-items:center;padding:16px 0;border-top:1px solid var(--rule)}}
.ag:first-child{{border-top:0}}
.ag .pic{{width:40px;height:40px;border-radius:12px}}
.ag h2{{margin:0;font:600 16px/1.3 var(--fd)}}
.ag p{{margin:2px 0 0;font-size:13.5px;color:var(--ink3)}}
.ag .acts{{display:flex;gap:12px;align-items:center}}
.grid{{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:22px;align-items:start}}
.stack{{display:flex;flex-direction:column;gap:22px}}
.tool{{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 16px;align-items:center;padding:14px 0;border-top:1px solid var(--rule)}}
.tool:first-of-type{{border-top:0;padding-top:0}}
.tool label{{font:500 14px var(--fm)}}
.tool p{{grid-column:1;margin:0;font-size:13.5px;color:var(--ink2)}}
.tool input{{grid-row:1/3;grid-column:2;appearance:none;-webkit-appearance:none;width:42px;height:24px;border-radius:12px;background:rgba(27,36,51,.2);position:relative;cursor:pointer;margin:0}}
.tool input::after{{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .25s}}
.tool input:checked{{background:var(--navy)}}
.tool input:checked::after{{transform:translateX(18px)}}
.pad{{padding:24px 26px}}
.tokrow{{display:flex;gap:8px;margin-top:8px}}
.tokrow input{{flex:1;min-width:0;min-height:44px;padding:0 12px;border-radius:10px;border:1.5px solid rgba(16,30,52,.22);background:rgba(255,255,255,.8);font:14px var(--fm);color:var(--t1)}}
.note{{margin:10px 0 0;font-size:13px;color:var(--t2)}}
.cheque{{background:#f3efe6 url({A['cheque']}) center/900px auto;overflow:hidden}}
.rules{{list-style:none;margin:0;padding:0}}
.rules li{{padding:12px 0;border-top:1.5px solid var(--ink);color:var(--ink2);font-size:13.5px}}
.rules li b{{display:block;color:var(--ink);font-weight:600;font-size:14.5px}}
""")

# ---------------------------------------------------------------- Phone: this week
PHONE = """
.r.p{min-height:844px;display:flex;flex-direction:column;font-size:15px}
.hd{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 12px 0;height:54px;padding:0 10px 0 16px;border-radius:16px}
.hd .ws{padding:0;font-size:18px}
.body{flex:1;padding:22px 16px 20px;display:flex;flex-direction:column;gap:18px}
.tabs{display:flex;justify-content:space-around;margin:0 12px 14px;height:62px;padding:0 6px;border-radius:20px}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:11.5px;color:var(--t2);text-decoration:none;border-radius:14px}
.tab svg{width:18px;height:18px}
.tab.on{color:var(--t1);font-weight:600}
.tab .dotw{position:relative}
.tab .dotw::after{content:"";position:absolute;top:-1px;right:-4px;width:7px;height:7px;border-radius:50%;background:var(--amber)}
"""
TABS = lambda on: f"""<nav class="tabs glass" aria-label="Sections">
    <a class="tab{' on' if on == 'week' else ''}" href="PhoneWeek.dc.html">{ICONS['week']}This week</a>
    <a class="tab{' on' if on == 'req' else ''}" href="PhoneApprove.dc.html"><span class="dotw">{ICONS['req']}</span>Requests</a>
    <a class="tab" href="Ledger.dc.html">{ICONS['ledger']}Ledger</a>
    <a class="tab" href="Agents.dc.html">{ICONS['agents']}Agents</a>
  </nav>"""
page("PhoneWeek", "phone, this week", f"""<div class="r p">
  <header class="hd glass"><div class="ws"><span class="mk"></span>This week</div><span class="chip glass live"><i></i>Hold active</span></header>
  <main class="body">
    <div class="hero">
      <div class="k">Left to spend, Nov 9 – 15</div>
      <div class="big">$55.20</div>
      <div class="k">of $176.50 held on PayPal. $121.30 captured.</div>
    </div>
    <section class="paper ask" aria-label="Request">
      <img class="stamp" src="{A['ask']}" alt="" style="right:12px;top:10px;width:84px;transform:rotate(8deg)">
      <p>Your agent is asking for $104.50 more for Sam’s gift.<span>The gift you picked is $144.50. The line has $40.00.</span></p>
      <a class="btn pri" href="PhoneApprove.dc.html">Review request</a>
    </section>
    <section class="paper lines" aria-label="Lines">
      <div class="ch">Lines</div>
      <div class="ln"><img src="{A['gro']}" alt=""><div><div class="lt">Groceries<span><b class="money">$1.20</b> left</span></div><div class="track"><div class="fill" style="width:98.6%"></div></div></div></div>
      <div class="ln"><img src="{A['dog']}" alt=""><div><div class="lt">Dog food<span><b class="money">$0.00</b> left</span></div><div class="track"><div class="fill" style="width:100%"></div></div></div></div>
      <div class="ln"><img src="{A['gift']}" alt=""><div><div class="lt">Gift for Sam<span><b class="money">$40.00</b> left</span></div><div class="track"><div class="fill" style="width:0%"></div></div></div></div>
      <div class="ln"><img src="{A['buf']}" alt=""><div><div class="lt">Shared buffer<span><b class="money">$14.00</b> left</span></div><div class="track"><div class="fill" style="width:12.5%"></div></div></div></div>
    </section>
  </main>
  {TABS('week')}
</div>""", PHONE + """
.hero .big{margin:8px 0 6px;font-size:58px}
.ask{padding:18px}
.ask p{margin:0 96px 14px 0;font-weight:600;line-height:1.35}
.ask p span{display:block;margin-top:4px;font-weight:400;font-size:13.5px;color:var(--ink2)}
.ask .btn{width:100%}
.lines{padding:18px}
.ln{display:grid;grid-template-columns:40px minmax(0,1fr);gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--rule)}
.ln:nth-of-type(2){border-top:0;padding-top:0}
.ln img{width:40px;filter:drop-shadow(0 2px 3px rgba(24,48,84,.25))}
.lt{display:flex;justify-content:space-between;margin-bottom:6px;font-weight:600;font-size:14.5px}
.lt span{font-weight:400;font-size:12.5px;color:var(--ink3)}
.lt b{font-size:14px;color:var(--ink)}
""", w=390, h=844)

# ---------------------------------------------------------------- Phone: approve a top-up
page("PhoneApprove", "phone, approve a top-up", f"""<div class="r p">
  <header class="hd glass"><a class="back" href="PhoneWeek.dc.html" aria-label="Back to this week"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>This week</a><span class="chip ask"><i></i>Waiting for you</span></header>
  <main class="body">
    <h1 class="t">Approve $104.50 more for Sam’s gift?</h1>
    <section class="paper" aria-label="The gift">
      <div class="prod"><img src="{A['product']}" alt="Watercolor travel set"><div><b>Watercolor travel set</b><span>Gift shop, wrapped. <b class="money">$144.50</b></span></div></div>
      <p class="why">“Sam mentioned wanting to paint on trips. This set has the best reviews of the ones that arrive before the 14th.”<span>Your agent, Thu 16:30</span></p>
      <div class="sum">
        <div><span>Gift for Sam now</span><span class="money">$40.00</span></div>
        <div><span>Top-up</span><span class="money">+ $104.50</span></div>
        <div class="tot"><span>After</span><span class="money">$144.50</span></div>
      </div>
    </section>
    <p class="note">A second hold on PayPal, for this line only. Anything unspent is released on Nov 15.</p>
  </main>
  <div class="foot glass">
    <a class="btn pri" href="PhoneWeek.dc.html">Approve on PayPal</a>
    <a class="btn sec" href="PhoneWeek.dc.html">Decline</a>
  </div>
</div>""", PHONE + """
.back{display:inline-flex;align-items:center;gap:4px;font-weight:500;font-size:14.5px;text-decoration:none}
.back svg{width:16px;height:16px}
.t{font-size:28px;letter-spacing:-.03em}
.paper{padding:18px}
.prod{display:grid;grid-template-columns:76px minmax(0,1fr);gap:14px;align-items:center}
.prod img{width:76px;aspect-ratio:1;object-fit:cover;border-radius:6px}
.prod b{display:block;font-weight:600}
.prod span{font-size:13.5px;color:var(--ink2)}
.why{margin:16px 0 0;padding:12px 14px;border-left:3px solid var(--ask);background:rgba(143,99,18,.07);font:400 13px/1.55 var(--ft)}
.why span{display:block;margin-top:6px;font:400 11.5px var(--fm);color:var(--ink3)}
.sum{margin-top:16px;border-top:1.5px solid var(--ink)}
.sum div{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--rule);font-size:14px}
.sum .tot{border-bottom:0;font-weight:600}
.note{margin:0;font-size:13.5px;color:var(--t2)}
.foot{display:flex;flex-direction:column;gap:8px;margin:0 12px 14px;padding:12px;border-radius:20px}
""", w=390, h=844)
print("built")
