#!/bin/env -S deno run --unstable-cron --allow-net=janet.zulipchat.com:443,irc.libera.chat:6697,ntfy.tionis.dev:443 --allow-env --env
import { Client as IrcClient } from "https://deno.land/x/irc@v0.15.0/mod.ts";

const version = "0.1.0";

// Types
type IntToStr = { [key: number]: string };
type StrToStr = { [key: string]: string };
type StrToInt = { [key: string]: number };

// Static Config[]
const NTFY_TOKEN: string = Deno.env.get(
  "JANET_ZULIP_IRC_BRIDGE_NTFY_TOKEN",
) as string;
const PING_TOKEN: string = Deno.env.get(
  "JANET_ZULIP_IRC_BRIDGE_PING_TOKEN",
) as string;
const zulipUsername: string =
  Deno.env.get("JANET_ZULIP_IRC_BRIDGE_ZULIP_USERNAME") ?? "";
const zulipKey: string = Deno.env.get("JANET_ZULIP_IRC_BRIDGE_ZULIP_KEY") ?? "";
const zulipAuthHeader: string = "Basic " + btoa(zulipUsername + ":" + zulipKey);
const ircAdmins: Set<string> = new Set(["tionis"]);
if (zulipUsername === "" || zulipKey === "") {
  console.error(
    "[ERROR] Zulip username or key not set in environment variables.",
  );
  Deno.exit(1);
}

async function ntfy(channel: string, message: string) {
  const result = await fetch(
    `https://ntfy.tionis.dev/janet-zulip-irc-bridge/${channel}`,
    {
      method: "POST",
      headers: { Authorization: NTFY_TOKEN },
      body: message,
    },
  );
  if (!result.ok) {
    console.error(`Failed to send notification: ${result.statusText}`);
  }
}

async function ntfy_json(channel: string, message: unknown) {
  const result = await fetch(
    `https://ntfy.tionis.dev/janet-zulip-irc-bridge/${channel}?format=json`,
    {
      method: "POST",
      headers: { Authorization: NTFY_TOKEN },
      body: JSON.stringify(message),
    },
  );
  if (!result.ok) {
    console.error(`Failed to send notification: ${result.statusText}`);
  }
}

// Helper functions
async function zulipGetQueue() {
  const resp = await fetch("https://janet.zulipchat.com/api/v1/register", {
    method: "POST",
    headers: {
      Authorization: zulipAuthHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      event_types: JSON.stringify(["message"]),
    }),
  });
  const text = await resp.text();
  return JSON.parse(text).queue_id;
}

// const bucket = new LeakyBucket({
//   // TODO this is broken atm
//   capacity: 5,
//   interval: 3,
// });
async function privmsg(target: string, message: string) {
  //await bucket.throttle();
  irc.privmsg(target, message);
}

// Dynamic Config
const subscriptions = await fetch(
  "https://janet.zulipchat.com/api/v1/users/me/subscriptions",
  { method: "GET", headers: { Authorization: zulipAuthHeader } },
)
  .then((resp) => resp.text())
  .then((text) => JSON.parse(text));

// Setting up queue
let queue_id: string = await zulipGetQueue();
let last_event_id: number = -1;

const zulipStreams: IntToStr = {};
for (const subscription of subscriptions.subscriptions) {
  zulipStreams[subscription.stream_id] = subscription.name;
}
const streamNameMap: StrToStr = {
  general: "#janet",
  "editors and tooling": "#janet-tooling",
};
const zulipID_to_IrcChannel: IntToStr = {};
const ircChannel_to_zulipID: StrToInt = {};

for (const [streamID, streamName] of Object.entries(zulipStreams)) {
  if (streamName in streamNameMap) {
    zulipID_to_IrcChannel[Number(streamID)] = streamNameMap[streamName];
  } else {
    zulipID_to_IrcChannel[Number(streamID)] =
      "#janet-" + streamName.replace(" ", "-");
  }
}

for (const [zulipID, ircChannel] of Object.entries(zulipID_to_IrcChannel)) {
  ircChannel_to_zulipID[ircChannel] = parseInt(zulipID);
}

const irc = new IrcClient({
  nick: "janet-zulip",
  authMethod: "sasl",
  reconnect: { attempts: -1, delay: 10 }, //, exponentialBackoff: true },
  channels: [
    Object.values(zulipID_to_IrcChannel)[0],
    ...Object.values(zulipID_to_IrcChannel).slice(1),
  ],
  password: Deno.env.get("JANET_ZULIP_IRC_BRIDGE_IRC_PASSWORD")!,
});

let last_heartbeat_time: Date;

irc.on("privmsg:channel", ({ source, params }) => {
  console.log(
    `[PRIVMSG] <irc> ${source?.name}@${params.target}: ${params.text}`,
  );
  if (source?.name === "janet-zulip") {
    return;
  }
  // Messages following this format are sent to zulip:
  // `#(topic-name): message` as a stream message in topic of the pattern `irc-name: message-content`
  if (params.text[0] === "#") {
    const parts = params.text.split(/\(([^)]*)\)[ :]*(.*)/s);
    const parameters = new URLSearchParams({
      type: "stream",
      to: zulipStreams[ircChannel_to_zulipID[params.target]],
      topic: parts[1],
      content: `${source?.name}: ${parts[2]}`,
    });
    fetch("https://janet.zulipchat.com/api/v1/messages", {
      method: "POST",
      headers: {
        Authorization: zulipAuthHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: parameters,
    })
      .then((resp) => resp.text())
      .then((text) => console.log(text));
  } else {
    const parameters = new URLSearchParams({
      type: "stream",
      to: zulipStreams[ircChannel_to_zulipID[params.target]],
      topic: "IRC",
      content: `${source?.name}: ${params.text}`,
    });
    fetch("https://janet.zulipchat.com/api/v1/messages", {
      method: "POST",
      headers: {
        Authorization: zulipAuthHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: parameters,
    })
      .then((resp) => resp.text())
      .then((text) => console.log(text));
  }
});

irc.on("invite", (msg) => {
  console.log(
    `[INVITE] ${msg.params.nick} was invited to ${msg.params.channel}`,
  );
  //client.join(msg.params.channel);
});

irc.on("register", (msg) => {
  console.log(
    `[REGISTER] Registered as ${msg.params.nick} with message: ${msg.params.text}`,
  );
});

irc.on("connected", (remoteAddr) => {
  console.log(
    `[CONNECTED] Connected to server (${JSON.stringify(remoteAddr)})`,
  );
});

irc.on("connecting", (remoteAddr) => {
  console.log(
    `[CONNECTING] Connecting to server (${JSON.stringify(remoteAddr)})`,
  );
});

irc.on("disconnected", (remoteAddr) => {
  console.log(
    `[DISCONNECTED] Disconnected from server (${JSON.stringify(remoteAddr)})`,
  );
});

irc.on("reconnecting", (remoteAddr) => {
  console.log(
    `[RECONNECTING] Reconnecting to server (${JSON.stringify(remoteAddr)})`,
  );
});

irc.on("notice", ({ source, params }) => {
  console.log(`[NOTICE] ${source?.name}: ${params.text}`);
});

irc.on("myinfo", (msg) => {
  console.log(
    `[MYINFO] Connected to ${JSON.stringify(
      msg.params.server,
    )} with user modes ${msg.params.usermodes} and channel modes ${msg.params.chanmodes}`,
  );
});

irc.on("error", (error) => {
  ntfy_json("errors/irc", {
    name: error.name,
    message: error.message,
    type: error.type.toString(),
  });
  console.log(
    `[ERROR] <irc> Name: ${error.name}\n[^^^^^] <irc> Message: ${error.message}\n[^^^^^] <irc> Type: ${error.type}`,
  );
});

irc.on("privmsg:private", ({ source, params }) => {
  console.log(`[PRIVMSG] <irc> ${source?.name}: ${params.text}`);
  const is_admin: boolean = ircAdmins.has(source?.name!);
  const commands: string[] = is_admin
    ? ["heartbeat", "ping", "help", "msg", "join", "part", "ntfy"]
    : ["heartbeat", "ping", "help"];
  const command = params.text.split(" ")[0];
  switch (command) {
    case "heartbeat":
      privmsg(source?.name!, last_heartbeat_time.toString());
      break;
    case "ping":
      privmsg(source?.name!, "pong");
      break;
    case "help":
      privmsg(source?.name!, `Commands: ${commands.join(", ")}`);
      break;
    case "msg":
      if (is_admin) {
        const [_, target, ...message] = params.text.split(" ");
        privmsg(target, message.join(" "));
      }
      break;
    case "join":
      if (is_admin) {
        const [_, channel] = params.text.split(" ");
        irc.join(channel);
      }
      break;
    case "part":
      if (is_admin) {
        const [_, channel] = params.text.split(" ");
        irc.part(channel);
      }
      break;
    case "ntfy":
      if (is_admin) {
        const [_, ...message] = params.text.split(" ");
        ntfy("irc/dm", message.join(" "));
      }
      break;
    case "version":
      privmsg(source?.name!, version);
      break;
    default:
      privmsg(
        source?.name!,
        `Unknown command. Commands: ${commands.join(", ")}`,
      );
  }
});

irc.connect("irc.libera.chat", 6697, true);

async function deadManPing() {
  const result = await fetch("https://cloud.tionis.dev/public.php/webdav/", {
    method: "PUT",
    headers: { Authorization: "Basic " + btoa(PING_TOKEN + ":") },
    body: new Date().getTime().toString(),
  });
  if (!result.ok) {
    console.error(`Failed to send ping: ${result.statusText}`);
  }
}
Deno.cron("deadManPing", "*/5 * * * *", deadManPing);

console.log("[INFO] Starting zulip event loop...");
(async () => {
  let failedPulls = 0;
  while (true) {
    try {
      const params = new URLSearchParams({
        queue_id: queue_id.toString(),
        last_event_id: last_event_id.toString(),
      }).toString();
      const url = "https://janet.zulipchat.com/api/v1/events?" + params;
      const resp = await fetch(url, {
        method: "GET",
        headers: { Authorization: zulipAuthHeader },
      });
      if (resp.headers.get("content-type") === "application/json") {
        const parsedResp = JSON.parse(await resp.text());
        if (parsedResp.result != "success") {
          switch (parsedResp.code) {
            case "BAD_EVENT_QUEUE_ID":
              console.log(
                "[INFO] <zulip> Event queue id expired. Requesting new queue id...",
              );
              queue_id = await zulipGetQueue();
              last_event_id = -1;
              continue;
            default:
              console.log("[ERROR] <zulip> Unknown error occurred:");
              console.log(parsedResp);
              for (const admin of ircAdmins) {
                privmsg(admin, `Error fetching events from zulip api:`);
                privmsg(admin, JSON.stringify(parsedResp));
              }
              break;
          }
          return;
        }
        for (const event of parsedResp.events) {
          failedPulls = 0;
          if (event.type === "heartbeat") {
            last_heartbeat_time = new Date();
          } else if (
            event.type === "message" &&
            event.message.sender_email !== zulipUsername
          ) {
            //console.log(["DEBUG", "New Message", event]);
            if (event.message.type === "stream") {
              console.log(
                `[INFO] <zulip> ${event.message.sender_full_name}(${event.message.subject})@${event.message.display_recipient}: ${event.message.content}`,
              );
              const irc_channel =
                zulipID_to_IrcChannel[event.message.stream_id];
              const lines = event.message.content.trim().split("\n");
              //const prefix = `${event.message.sender_full_name}(${event.message.subject}):`;
              console.log([
                "sending_irc_messages",
                {
                  event: event,
                  lines: lines,
                },
              ]);
              privmsg(
                irc_channel,
                `${event.message.sender_full_name}@[${event.message.subject}]:`,
              );
              for (const line of lines) {
                privmsg(irc_channel, line);
                //privmsg(irc_channel, `${prefix} ${line}`);
              }
            } else {
              console.log(
                event.message.sender_email + ": " + event.message.content,
              );
            }
          }
          last_event_id = event.id;
        }
      } else {
        failedPulls++;
      }
    } catch (e) {
      console.log(`[ERROR] <zulip> Error fetching events from zulip api: ${e}`);
      for (const admin of ircAdmins) {
        privmsg(admin, `Error fetching events from zulip api:`);
        privmsg(admin, e.toString());
      }
      // wait for 10 seconds before retrying
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    if (failedPulls >= 5) {
      ntfy(
        "errors/zulip",
        "Failed to fetch events from zulip api 5 times in a row. Waiting for 1 minute before retrying.",
      );
      failedPulls = 0;
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
  }
})();
