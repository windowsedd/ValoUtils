import Store from "../../util/store.ts";
import { Profile } from "@/types/profile.ts";
import { clipboard, ipcMain, IpcMainEvent } from "electron";
import { getPreferences, loadSettings } from "../../util/riot/settings.ts";
import { saveData } from "../../util/share.ts";
import { decodeProfileData, extractCrosshairProfiles } from "../../util/settings-decoder.ts";

const dataStore = new Store({
    configName: 'profiles',
    defaults: {
        profiles: []
    }
})

export const getProfiles = () => {
    return dataStore.get('profiles') as Profile[];
}
export const setProfiles = (profiles: Profile[]) => {
    dataStore.set('profiles', profiles);
}
export const addProfile = (profile: Profile) => {
    const profiles = getProfiles();
    profile.created = new Date().getTime();
    profile.updated = profile.created;
    profiles.push(profile);
    setProfiles(profiles);
    return profiles;
}

export const initSettingsIpc = () => {
    ipcMain.on("settings:get", async (event: IpcMainEvent) => {
        event.sender.send("settings:get", JSON.stringify(await getPreferences()));
    });
    ipcMain.on("settings:profile:list", async (event: IpcMainEvent) => {
        event.sender.send("settings:profile:list", JSON.stringify({
            profiles: getProfiles(),
            success: true
        }));
    });
    ipcMain.on("settings:profile:add", async (event: IpcMainEvent, profile: string) => {
        const name = "Profile " + new Date().toLocaleString();
        let newProfiles;
        if (profile === "current") {
            try {
                const prefrences = await getPreferences();
                const data = prefrences.data;
                const newProfile: Profile = {
                    name,
                    data
                };
                newProfiles = addProfile(newProfile);
            } catch (error) {
                event.sender.send("settings:profile:add", JSON.stringify({
                    error: (error as any).toString(),
                    profiles: getProfiles()
                }));
                return;
            }
        } else if (profile === "clipboard") {
            const data = clipboard.readText();
            const newProfile: Profile = {
                name,
                data
            };
            newProfiles = addProfile(newProfile);
        } else {
            const newProfile: Profile = {
                name,
                data: profile
            };
            newProfiles = addProfile(newProfile);
        }
        const stringified = JSON.stringify({
            profiles: newProfiles,
            success: true
        });
        event.sender.send("settings:profile:list", stringified);
        event.sender.send("settings:profile:add", stringified);
    });
    ipcMain.on("settings:profile:remove", async (event: IpcMainEvent, profile: string) => {
        const profiles = getProfiles();
        const newProfiles = profiles.filter((p) => p.name !== profile);
        setProfiles(newProfiles);
        event.sender.send("settings:profile:list", JSON.stringify({
            profiles: newProfiles,
            success: true
        }));
        event.sender.send("settings:profile:remove", JSON.stringify({
            profiles: newProfiles,
            success: true
        }));
    });
    ipcMain.on("settings:profile:rename", async (event: IpcMainEvent, profile: string, newName: string) => {
        const profiles = getProfiles();
        const newProfiles = profiles.map((p) => {
            if (p.name === profile) {
                p.name = newName;
                p.updated = new Date().getTime();
            }
            return p;
        });
        // find duplicate names
        const names = newProfiles.map((p) => p.name);
        const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
        if (duplicates.length > 0) {
            event.sender.send("settings:profile:rename", JSON.stringify({
                error: "Duplicate names",
                profiles: newProfiles,
                success: false
            }));
            return;
        }
        setProfiles(newProfiles);
        event.sender.send("settings:profile:list", JSON.stringify({
            profiles: newProfiles,
            success: true
        }));
        event.sender.send("settings:profile:rename", JSON.stringify({
            profiles: newProfiles,
            success: true
        }));
    });
    ipcMain.on("settings:profile:duplicate", async (event: IpcMainEvent, profileName: string) => {
        const profiles = getProfiles();
        const profile = profiles.find((p) => p.name === profileName);
        if (!profile) {
            event.sender.send("settings:profile:duplicate", JSON.stringify({
                error: "Profile not found",
                success: false
            }));
            return;
        }
        const existingNames = profiles.map((p) => p.name);
        let newName = `${profile.name} (copy)`;
        let copyIndex = 2;
        while (existingNames.includes(newName)) {
            newName = `${profile.name} (copy ${copyIndex})`;
            copyIndex++;
        }
        const now = new Date().getTime();
        const newProfiles = [...profiles, {
            name: newName,
            data: profile.data,
            created: now,
            updated: now
        }];
        setProfiles(newProfiles);
        event.sender.send("settings:profile:list", JSON.stringify({
            profiles: newProfiles,
            success: true
        }));
        event.sender.send("settings:profile:duplicate", JSON.stringify({
            profiles: newProfiles,
            success: true
        }));
    });
    ipcMain.on("settings:profile:load", async (event: IpcMainEvent, profileName: string) => {
        const profile = getProfiles().find((p) => p.name === profileName);
        if (!profile) {
            event.sender.send("settings:profile:load", JSON.stringify({
                error: "Profile not found",
                success: false
            }));
            return;
        }
        const res = await loadSettings(profile);
        console.log(res);
        event.sender.send("settings:profile:load", JSON.stringify({
            success: true,
            data: res
        }));
    });
    ipcMain.on("settings:profile:view", async (event: IpcMainEvent, profileName: string) => {
        const profile = getProfiles().find((p) => p.name === profileName);
        if (!profile) {
            event.sender.send("settings:profile:view", JSON.stringify({
                error: "Profile not found",
                success: false
            }));
            return;
        }
        try {
            const settings = decodeProfileData(profile.data);
            const crosshairs = extractCrosshairProfiles(settings);
            event.sender.send("settings:profile:view", JSON.stringify({
                success: true,
                settings,
                crosshairs
            }));
        } catch (error) {
            event.sender.send("settings:profile:view", JSON.stringify({
                error: (error as any).toString(),
                success: false
            }));
        }
    });
    ipcMain.on("settings:current:view", async (event: IpcMainEvent) => {
        try {
            const prefs = await getPreferences();
            const settings = decodeProfileData(prefs.data);
            const crosshairs = extractCrosshairProfiles(settings);
            event.sender.send("settings:current:view", JSON.stringify({
                success: true,
                settings,
                crosshairs
            }));
        } catch (error) {
            event.sender.send("settings:current:view", JSON.stringify({
                error: (error as any).toString(),
                success: false
            }));
        }
    });
    ipcMain.on("settings:profile:share", async (event: IpcMainEvent, profileName: string) => {
        const profile = getProfiles().find((p) => p.name === profileName);
        if (!profile) {
            event.sender.send("settings:profile:share", JSON.stringify({
                error: "Profile not found",
                success: false
            }));
            return;
        }
        const { data } = profile;
        const id = await saveData(data);
        event.sender.send("settings:profile:share", JSON.stringify({
            code: id,
            success: true
        }));
    });
}