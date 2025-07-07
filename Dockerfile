FROM denoland/deno:1.45.5

WORKDIR /app

#USER deno

COPY deno.jsonc /app/deno.jsonc
COPY deno.lock /app/deno.lock
COPY main.ts /app/main.ts

#RUN deno cache --lock=deno.lock main.ts

ENV TINI_SUBREAPER=1

CMD ["run", "--allow-net", "--unstable-cron", "--allow-env", "/app/main.ts"]
