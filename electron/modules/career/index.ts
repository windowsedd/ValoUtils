import { ipcMain, IpcMainEvent } from "electron";
import { API, local } from "@windowsed1225/valorant-api";
import { getRegionLocale } from "../../util/riot-client.ts";

const { LocalRiotClientAPI } = local;

const REGION_TO_SHARD: Record<string, string> = {
    NA: "na", LATAM: "latam", BR: "br",
    EU: "eu", AP: "ap", KR: "kr",
    TW2: "ap", SG2: "ap", JP: "ap",
    VN2: "ap", PBE: "na",
};

const createApi = async (): Promise<API> => {
    const localClient = LocalRiotClientAPI.initFromLockFile();
    const { data } = await localClient.getEntitlementsToken();

    const locale = await getRegionLocale();
    const region = REGION_TO_SHARD[(locale.region ?? "").toUpperCase()]
        ?? (locale.region ?? "na").toLowerCase();

    const api = new API();
    await api.init({
        accessToken: data.accessToken,
        entitlementsToken: data.token,
        puuid: data.subject,
        region,
    });
    return api;
};

export const initCareerIpc = () => {
    ipcMain.on("career:get", async (event: IpcMainEvent) => {
        try {
            const api = await createApi();
            const puuid = api.data.puuid!;

            const [mmr, competitiveUpdates] = await Promise.all([
                api.player.getMMR(puuid),
                api.matches.getCompetitiveHistory(puuid, 0, 15),
            ]);

            event.sender.send("career:get", JSON.stringify({
                success: true,
                mmr,
                competitiveUpdates,
            }));
        } catch (error) {
            event.sender.send("career:get", JSON.stringify({
                success: false,
                error: (error as any).toString(),
            }));
        }
    });
};
