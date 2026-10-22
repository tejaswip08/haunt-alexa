import type { ReactNode } from "react";
import type { DeviceState } from "../lib/device.ts";

/**
 * An unbranded smart-display frame: screen, bezel, camera dot, fabric speaker base,
 * and a light bar that shows what the device is doing.
 */
export function DeviceFrame({ state, children }: { state: DeviceState; children: ReactNode }) {
  return (
    <div className="device" data-state={state}>
      <div className="device-bezel">
        <span className="device-camera" aria-hidden />
        <div className="device-screen">{children}</div>
      </div>
      <div className="device-base" aria-hidden>
        <span className="device-lightbar" />
      </div>
    </div>
  );
}
