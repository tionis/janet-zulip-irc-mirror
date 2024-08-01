FROM denoland/deno:1.45.5

WORKDIR /app

#USER deno

COPY deno.jsonc /app/deno.jsonc
COPY deno.lock /app/deno.lock
COPY main.ts /app/main.ts

RUN deno cache --lock=deno.lock main.ts

CMD ["run", "--allow-net=janet.zulipchat.com:443,irc.libera.chat:6697", "--allow-env=ZULIP_USERNAME,ZULIP_KEY,ZULIP_QUEUE_ID,IRC_PASSWORD", "/app/main.ts"]
