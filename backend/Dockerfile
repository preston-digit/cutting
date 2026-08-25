FROM node:20-alpine

# Font is vendored in-repo (backend/assets/fonts/, see LICENSE there) and
# registered at module load by labelRenderer.js via @napi-rs/canvas's
# GlobalFonts.registerFromPath — no OS font package needed here anymore.
# This keeps Docker and Heroku (whose buildpack dyno has no apk/apt step at
# all) rendering labels identically off the same vendored files, rather than
# depending on whatever fonts each environment happens to have installed.

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 4001

CMD ["npm", "start"]
