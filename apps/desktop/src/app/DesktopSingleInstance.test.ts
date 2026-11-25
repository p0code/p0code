import { assert, it } from "@effect/vitest";
import { claimDesktopInstance } from "./DesktopSingleInstance.ts";

it("only starts one desktop and activates it on subsequent launches", () => {
  let locked = false;
  let secondInstance: (() => void) | undefined;
  let starts = 0;
  let activations = 0;
  const exits: number[] = [];
  const app = {
    requestSingleInstanceLock: () => {
      if (locked) {
        secondInstance?.();
        return false;
      }
      locked = true;
      return true;
    },
    exit: (code: number) => {
      exits.push(code);
    },
    on: (_event: "second-instance", listener: () => void) => {
      secondInstance = listener;
    },
    emit: (_event: "activate") => {
      activations += 1;
      return true;
    },
  };
  if (claimDesktopInstance(app)) starts += 1;
  if (claimDesktopInstance(app)) starts += 1;
  assert.equal(starts, 1);
  assert.equal(activations, 1);
  assert.deepEqual(exits, [0]);
});
