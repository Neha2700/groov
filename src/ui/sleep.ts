// Sleep timer: stop the music after 15/30/45/60 minutes, or when this song
// ends. Uses the clock (not a countdown), so it's right even if the phone
// slept for a while.
import { isPlaying, isStopAfterCurrent, pause, setStopAfterCurrent } from "../player/player";
import { bus } from "../state";
import { $ } from "../utils";
import { chooseOption } from "./choice";

const btn = $("np-sleep");
let endsAt = 0;
let timer = 0;

type Choice = number | "song" | "off";

function minutesLeft(): number {
  return Math.max(1, Math.ceil((endsAt - Date.now()) / 60000));
}

function render(): void {
  const song = isStopAfterCurrent();
  const on = song || endsAt > 0;
  btn.classList.toggle("active", on);
  btn.querySelector(".np-sleep-label")!.textContent = song ? "End of song" : endsAt ? `${minutesLeft()} min` : "Sleep";
}

function cancel(): void {
  endsAt = 0;
  clearInterval(timer);
  setStopAfterCurrent(false);
}

function check(): void {
  if (!endsAt) return;
  if (Date.now() >= endsAt) {
    cancel();
    if (isPlaying()) {
      pause();
      bus.emit("toast", "🌙 Sleep timer: music stopped");
    }
  }
  render();
}

export function setSleepTimer(choice: Choice): void {
  cancel();
  if (choice === "song") {
    setStopAfterCurrent(true);
    bus.emit("toast", "🌙 Music will stop when this song ends");
  } else if (typeof choice === "number") {
    endsAt = Date.now() + choice * 60000;
    timer = window.setInterval(check, 10000);
    bus.emit("toast", `🌙 Music will stop in ${choice} minutes`);
  }
  render();
}

async function open(): Promise<void> {
  const song = isStopAfterCurrent();
  const note = song ? "Stopping when this song ends" : endsAt ? `Stopping in ${minutesLeft()} min` : "";
  const options: { label: string; value: Choice; active?: boolean }[] = [
    { label: "15 minutes", value: 15 },
    { label: "30 minutes", value: 30 },
    { label: "45 minutes", value: 45 },
    { label: "1 hour", value: 60 },
    { label: "End of this song", value: "song", active: song },
  ];
  if (song || endsAt) options.push({ label: "Turn off timer", value: "off" });
  const choice = await chooseOption<Choice>("Sleep timer", options, note);
  if (choice !== null) setSleepTimer(choice);
}

export function initSleep(): void {
  btn.addEventListener("click", () => void open());
  bus.on("sleepchange", render);
  // Coming back to the app after a while: catch up straight away.
  document.addEventListener("visibilitychange", check);
  render();
}
