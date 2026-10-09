/** Minimal embed builder (the website has no discord.js): just enough for the log posts. */
export class EmbedBuilder {
  constructor() {
    this.data = {};
  }

  title(t) {
    this.data.title = String(t).slice(0, 256);
    return this;
  }

  color(c) {
    this.data.color = c;
    return this;
  }

  field(name, value, inline = false) {
    (this.data.fields ??= []).push({ name: String(name).slice(0, 256), value: String(value).slice(0, 1024) || '-', inline });
    return this;
  }

  timestamp(iso) {
    this.data.timestamp = iso;
    return this;
  }

  toJSON() {
    return this.data;
  }
}
