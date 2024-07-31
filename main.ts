#!/bin/env -S deno run --allow-net=janet.zulipchat.com:443,irc.libera.chat:6697 --allow-env=ZULIP_USERNAME,ZULIP_KEY,ZULIP_QUEUE_ID,IRC_PASSWORD --allow-read=".db" --allow-write=".db"
import { exec, OutputMode } from "https://deno.land/x/exec/mod.ts";
import { Client } from "https://deno.land/x/irc/mod.ts";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";

type IntToStr = { [key: number]: string };
type StrToStr = { [key: string]: string };
type StrToInt = { [key: string]: number };

const username: string = Deno.env.get("ZULIP_USERNAME")!;
const password: string = Deno.env.get("ZULIP_KEY")!;
const authHeader: string = "Basic " + btoa(username + ":" + password);
const queue_id: number = Number(Deno.env.get("ZULIP_QUEUE_ID")!);
const store_dir: string = ".db";
let last_event_id: number = Number(Deno.readTextFileSync(store_dir + "/last_event_id"),);
console.log("Starting from event id: " + last_event_id.toString());

const fetch_config = {
  method: "GET",
  headers: {
    "Authorization": authHeader,
  },
};

const subscriptions = await fetch(
  "https://janet.zulipchat.com/api/v1/users/me/subscriptions",
  fetch_config,
).then((resp) => resp.text()).then((text) => JSON.parse(text));

const zulipStreams: IntToStr = {};
for (const subscription of subscriptions.subscriptions) {
  zulipStreams[subscription.stream_id] = subscription.name;
}
const streamNameMap: StrToStr = {
  "general": "#janet",
  "editors and tooling": "#janet-tooling",
};
const zulipID_to_IrcChannel: IntToStr = {};
const ircChannel_to_zulipID: StrToInt = {};

for (const [streamID, streamName] of Object.entries(zulipStreams)) {
  if (streamName in streamNameMap) {
    zulipID_to_IrcChannel[streamID] = streamNameMap[streamName];
  } else {
    zulipID_to_IrcChannel[streamID] = "#janet-" + streamName.replace(" ", "-");
  }
}

for (const [zulipID, ircChannel] of Object.entries(zulipID_to_IrcChannel)) {
  ircChannel_to_zulipID[ircChannel] = parseInt(zulipID);
}

const client = new Client({
  nick: "janet-zulip",
  authMethod: "sasl",
  channels: Object.values(zulipID_to_IrcChannel),
  password: Deno.env.get("IRC_PASSWORD")!,
});

let last_hearbeat_time: Date;

client.on("privmsg:channel", ({ source, params }) => {
  console.log(
    `[PRIVMSG] from: ${source?.name} to: ${params.target}\n${params.text}\n`,
  );
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
        "Authorization": authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: parameters,
    }).then((resp) => resp.text()).then((text) => console.log(text));
  }
});

client.on("invite", (msg) => {
  console.log(
    `[INVITE] ${msg.params.nick} was invited to ${msg.params.channel}`,
  );
  //client.join(msg.params.channel);
});

client.on("register", (msg) => {
  console.log(
    `[REGISTER] Registered as ${msg.params.nick} with message: ${msg.params.text}`,
  );
});

client.on("connected", (remoteAddr) => {
  console.log(
    `[CONNECTED] Connected to server (${JSON.stringify(remoteAddr)})`,
  );
});

client.on("connecting", (remoteAddr) => {
  console.log(
    `[CONNECTING] Connecting to server (${JSON.stringify(remoteAddr)})`,
  );
});

client.on("disconnected", (remoteAddr) => {
  console.log(
    `[DISCONNECTED] Disconnected from server (${JSON.stringify(remoteAddr)})`,
  );
});

client.on("reconnecting", (remoteAddr) => {
  console.log(
    `[RECONNECTING] Reconnecting to server (${JSON.stringify(remoteAddr)})`,
  );
});

client.on("notice", ({ source, params }) => {
  console.log(`[NOTICE] From ${source?.name}\n ${params.text}\n`);
});

client.on("myinfo", (msg) => {
  console.log(
    `[MYINFO] Connected to ${
      JSON.stringify(msg.params.server)
    } with user modes ${msg.params.usermodes} and channel modes ${msg.params.chanmodes}`,
  );
});

client.on("error", (error) => {
  console.log(
    `[Error]:\n  Name: ${error.name}\n  Message: ${error.message}\n  Type: ${error.type}`,
  );
});

client.on("privmsg:private", ({ source, params }) => {
  console.log("[PRIVMSG] from: " + source?.name + "\n" + params.text + "\n");
  const command = params.text.split(" ")[0];
  switch (command) {
    case "heartbeat":
      client.privmsg(source?.name!, last_hearbeat_time.toString());
      break;
    case "ping":
      client.privmsg(source?.name!, "pong");
      break;
    case "help":
      client.privmsg(source?.name!, "Commands: heartbeat, ping, help");
      break;
    default:
      client.privmsg(source?.name!, "Unknown command. Commands: heartbeat, ping, help");
  }
});

console.log("Connecting to IRC...");
client.connect("irc.libera.chat", 6697, true);

console.log("Starting zulip event loop...");
(async () => {
  while (true) {
    const params = new URLSearchParams({
      queue_id: queue_id.toString(),
      last_event_id: last_event_id.toString(),
    }).toString();
    const url = "https://janet.zulipchat.com/api/v1/events?" + params;
    const resp = await fetch(url, fetch_config);
    const parsedResp = JSON.parse(await resp.text());
    if (parsedResp.result != "success") {
      console.log(parsedResp);
      console.log("Error fetching events. Retrying in 5 seconds...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    for (const event of parsedResp.events) {
      if (event.type === "heartbeat") {
        last_hearbeat_time = new Date();
      } else if (
        event.type === "message" && event.message.sender_email !== username
      ) {
        console.log(["New Message", event]);
        if (event.message.type === "stream") {
          console.log(
            `New Message in ${event.message.display_recipient}#${event.message.subject}:\n${event.message.content}`,
          );
          const irc_channel = zulipID_to_IrcChannel[event.message.stream_id];
          const lines = event.message.content.split("\n");
          const prefix = `${event.message.sender_full_name}(${event.message.subject}):`;
          if (lines.length > 1) {
            for (const line of lines) {
              client.privmsg(irc_channel, `${prefix} ${line}`);
            }
          } else {
            client.privmsg(irc_channel, `${prefix} ${event.message.content}`);
          }
        } else {
          console.log(
            event.message.sender_email + ": " + event.message.content,
          );
        }
      }
      last_event_id = event.id;
    }
    await Deno.writeTextFile(
      store_dir + "/last_event_id",
      last_event_id.toString(),
    );
  }
})();
