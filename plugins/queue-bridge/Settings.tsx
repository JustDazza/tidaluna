import * as React from "react";
import { ReactiveStore } from "@luna/core";
import { LunaSettings, LunaTextSetting } from "@luna/ui";

export const storage = ReactiveStore.getStore("QueueBridge");
export const settings = await ReactiveStore.getPluginStorage("QueueBridge", {
	webSocketPort: 8080,
	cooldownSeconds: 10,
	webSocketPassword: ""
});

export const Settings = () => {
	const [portText, setPortText] = React.useState(String(settings.webSocketPort));
	const [cooldownText, setCooldownText] = React.useState(String(settings.cooldownSeconds));

	return (
		<LunaSettings>
			<LunaTextSetting
				title="Streamer.bot WebSocket Port"
				desc="Port of the Streamer.bot WebSocket Server (Default: 8080). Reload the plugin after changing this."
				tooltip="Streamer.bot > Servers/Clients > WebSocket Server"
				value={portText}
				onChange={(value: string) => {
					setPortText(value);
					const portNumber = parseInt(value, 10);
					if (!isNaN(portNumber) && portNumber > 0 && portNumber < 65536) {
						settings.webSocketPort = portNumber;
					}
				}}
			/>
			<LunaTextSetting
				title="Request Cooldown (seconds)"
				desc="How long each viewer must wait between song requests. Mods and the broadcaster are exempt. Use 0 to disable."
				tooltip="Default: 10 seconds"
				value={cooldownText}
				onChange={(value: string) => {
					setCooldownText(value);
					const seconds = parseFloat(value);
					if (!isNaN(seconds) && seconds >= 0 && seconds <= 3600) {
						settings.cooldownSeconds = seconds;
					}
				}}
			/>
      <LunaTextSetting
        title="Streamer.bot WebSocket Password"
        desc="Leave blank if your Streamer.bot WebSocket server has no password. Reload the plugin after changing this."
        tooltip="Streamer.bot > Servers/Clients > WebSocket Server"
        value={settings.webSocketPassword}
        onChange={(value: string) => {
          settings.webSocketPassword = value;
        }}
      />
		</LunaSettings>
	);
};
