FROM denoland/deno:1.45.5

WORKDIR /app

#USER deno

COPY deno.jsonc /app/deno.jsonc
COPY deno.lock /app/deno.lock
COPY main.ts /app/main.ts

#RUN deno cache --lock=deno.lock main.ts

CMD ["run", "--allow-net=janet.zulipchat.com:443,irc.libera.chat:6697,ntfy.tionis.dev:443,cloud.tionis.dev:443", "--unstable-cron", "--allow-env", "/app/main.ts"]
