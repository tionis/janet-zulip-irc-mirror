#!/bin/env -S deno run --allow-net=janet.zulipchat.com:443,irc.libera.chat:6697 --allow-env=JANET_ZULIP_IRC_BRIDGE_ZULIP_USERNAME,JANET_ZULIP_IRC_BRIDGE_ZULIP_KEY,JANET_ZULIP_IRC_BRIDGE_IRC_PASSWORD --env
import { Client as IrcClient } from "https://deno.land/x/irc/mod.ts";

// Types
type IntToStr = { [key: number]: string };
type StrToStr = { [key: string]: string };
type StrToInt = { [key: string]: number };

// Static Config[]
const zulipUsername: string =
  Deno.env.get("JANET_ZULIP_IRC_BRIDGE_ZULIP_USERNAME") ?? "";
const zulipKey: string = Deno.env.get("JANET_ZULIP_IRC_BRIDGE_ZULIP_KEY") ?? "";
const zulipAuthHeader: string = "Basic " + btoa(zulipUsername + ":" + zulipKey);
const ircAdmins: string[] = ["tionis"];
if (zulipUsername === "" || zulipKey === "") {
  console.error(
    "[ERROR] Zulip username or key not set in environment variables.",
  );
  Deno.exit(1);
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
  reconnect: { attempts: -1, delay: 10, exponentialBackoff: true },
  channels: Object.values(zulipID_to_IrcChannel),
  password: Deno.env.get("JANET_ZULIP_IRC_BRIDGE_IRC_PASSWORD")!,
});

let last_hearbeat_time: Date;

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
  console.log(
    `[ERROR] <irc> Name: ${error.name}\n[^^^^^] <irc> Message: ${error.message}\n[^^^^^] <irc> Type: ${error.type}`,
  );
  // TODO send admin notification (over some other channel)
});

irc.on("privmsg:private", ({ source, params }) => {
  console.log(`[PRIVMSG] <irc> ${source?.name}: ${params.text}`);
  const is_admin: boolean = ircAdmins.includes(source?.name!);
  const commands: string[] = is_admin
    ? ["heartbeat", "ping", "help"]
    : ["heartbeat", "ping", "help", "msg", "join", "part"];
  const command = params.text.split(" ")[0];
  switch (command) {
    case "heartbeat":
      irc.privmsg(source?.name!, last_hearbeat_time.toString());
      break;
    case "ping":
      irc.privmsg(source?.name!, "pong");
      break;
    case "help":
      irc.privmsg(source?.name!, `Commands: ${commands.join(", ")}`);
      break;
    case "msg":
      if (is_admin) {
        const [_, target, ...message] = params.text.split(" ");
        irc.privmsg(target, message.join(" "));
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
    default:
      irc.privmsg(
        source?.name!,
        `Unknown command. Commands: ${commands.join(", ")}`,
      );
  }
});

irc.connect("irc.libera.chat", 6697, true);

console.log("[INFO] Starting zulip event loop...");
(async () => {
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
              irc.privmsg(admin, `Error fetching events from zulip api:`);
              irc.privmsg(admin, JSON.stringify(parsedResp));
            }
            break;
        }
        return;
      }
      for (const event of parsedResp.events) {
        if (event.type === "heartbeat") {
          last_hearbeat_time = new Date();
        } else if (
          event.type === "message" &&
          event.message.sender_email !== zulipUsername
        ) {
          console.log(["DEBUG", "New Message", event]);
          if (event.message.type === "stream") {
            console.log(
              `[INFO] <zulip> ${event.message.sender_full_name}(${event.message.subject})@${event.message.display_recipient}: ${event.message.content}`,
            );
            const irc_channel = zulipID_to_IrcChannel[event.message.stream_id];
            const lines = event.message.content.trim().split("\n");
            const prefix = `${event.message.sender_full_name}(${event.message.subject}):`;
            console.log([
              "sending_irc_messages",
              {
                event: event,
                lines: lines,
              },
            ]);
            for (const line of lines) {
              irc.privmsg(irc_channel, `${prefix} ${line}`);
            }
          } else {
            console.log(
              event.message.sender_email + ": " + event.message.content,
            );
          }
        }
        last_event_id = event.id;
      }
    } catch (e) {
      console.log(`[ERROR] <zulip> Error fetching events from zulip api: ${e}`);
      for (const admin of ircAdmins) {
        irc.privmsg(admin, `Error fetching events from zulip api:`);
        irc.privmsg(admin, e.toString());
      }
      // wait for 10 seconds before retrying
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
})();
