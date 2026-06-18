import { Profile } from "@/types/profile.ts";
import { SettingsResponse } from "@/types/settings.ts";
import axios from "axios";
import { getTokens } from "../riot-client.ts";

export const getPreferences = async () => {
	const token = await getTokens();
	const response = await axios.get("https://player-preferences-usw2.pp.sgp.pvp.net/playerPref/v3/getPreference/Ares.PlayerSettings", {
		headers: {
			Authorization: `Bearer ${token.accessToken}`,
			"X-Riot-Entitlements-JWT": token.token,
		},
	});
	return response.data as SettingsResponse;
};
export const loadSettings = async (profile: Profile) => {
	console.log(`Loading profile ${profile.name}`);
	const token = await getTokens();
	// PUT https://playerpreferences.riotgames.com/playerPref/v3/savePreference
	const response = await axios.put(
		"https://player-preferences-usw2.pp.sgp.pvp.net/playerPref/v3/savePreference",
		{
			type: "Ares.PlayerSettings",
			data: profile.data,
		},
		{
			headers: {
				Authorization: `Bearer ${token.accessToken}`,
				"X-Riot-Entitlements-JWT": token.token,
			},
		}
	);
	return response.data as SettingsResponse;
};
