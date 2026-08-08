import CustomButton from "@/components/button.tsx";
import { useDynamicModal } from "@/components/dynamic-modal.tsx";
import { ParsedSettingsViewer } from "@/components/parsed-settings-viewer.tsx";
import { PageHeader, SectionCard, SectionRow } from "@/components/section-card";
import { SettingsDiffViewer } from "@/components/settings-diff-viewer.tsx";
import { Profile } from "@/types/profile.ts";
import formatUnixMillis from "@/util/format-date.ts";
import { Input, Label, TextField } from "@heroui/react";
import { useEffect, useState } from "react";
import { FaCogs, FaEdit } from "react-icons/fa";
import { FaCodeCompare, FaCopy, FaEye, FaPlus, FaShare, FaTrash, FaTriangleExclamation, FaUsers } from "react-icons/fa6";
import { getData } from "@/util/share.ts";
import { useTranslation, Trans } from "react-i18next";

const ViewSettingsModalBody = ({ data }: { data: any }) => (
	<ParsedSettingsViewer rawSettings={data?.settings} crosshairData={data?.crosshairs ?? null} />
);

/** Compact icon action sitting at the right of a profile row. */
const iconButtonClass = "min-w-8 px-2";

const SettingsProfiles = () => {
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const { showModal, closeModal } = useDynamicModal();
	const { t } = useTranslation();

	const refreshProfiles = () => {
		window.Main.send("settings:profile:list");
	};

	const compareProfileWithCurrent = (profileName: string, resolve: () => void, reject: (e: string) => void) => {
		window.Main.on("settings:profile:view", (msgA: string) => {
			window.Main.removeAllListeners("settings:profile:view");
			const dataA = JSON.parse(msgA);
			if (dataA.error) { reject(dataA.error); return; }
			window.Main.on("settings:current:view", (msgB: string) => {
				window.Main.removeAllListeners("settings:current:view");
				const dataB = JSON.parse(msgB);
				if (dataB.error) { reject(dataB.error); return; }
				showModal({
					title: t("profiles.settingsDiff"),
					body: <SettingsDiffViewer nameA={profileName} nameB={t("profiles.currentAccount")} rawA={dataA.settings} rawB={dataB.settings} />,
					footer: (
						<CustomButton className="w-full" color="danger" onPress={() => { closeModal(); resolve(); }}>
							{t("common.close")}
						</CustomButton>
					),
					onClose: resolve,
				});
			});
			window.Main.send("settings:current:view");
		});
		window.Main.send("settings:profile:view", profileName);
	};

	const compareTwoProfiles = (nameA: string, nameB: string, resolve: () => void, reject: (e: string) => void) => {
		window.Main.on("settings:profile:view", (msgA: string) => {
			window.Main.removeAllListeners("settings:profile:view");
			const dataA = JSON.parse(msgA);
			if (dataA.error) { reject(dataA.error); return; }
			window.Main.on("settings:profile:view", (msgB: string) => {
				window.Main.removeAllListeners("settings:profile:view");
				const dataB = JSON.parse(msgB);
				if (dataB.error) { reject(dataB.error); return; }
				showModal({
					title: t("profiles.settingsDiff"),
					body: <SettingsDiffViewer nameA={nameA} nameB={nameB} rawA={dataA.settings} rawB={dataB.settings} />,
					footer: (
						<CustomButton className="w-full" color="danger" onPress={() => { closeModal(); resolve(); }}>
							{t("common.close")}
						</CustomButton>
					),
					onClose: resolve,
				});
			});
			window.Main.send("settings:profile:view", nameB);
		});
		window.Main.send("settings:profile:view", nameA);
	};

	useEffect(() => {
		if (window.Main) {
			window.Main.on("settings:profile:list", (message: string) => {
				setProfiles(JSON.parse(message).profiles);
			});
			window.Main.send("settings:profile:list");
			return () => {
				window.Main.removeAllListeners("settings:profile:list");
			};
		}
	}, []);

	// --- Actions ------------------------------------------------------------
	// Each returns the promise CustomButton drives its pending state from.

	const addProfile = () =>
		new Promise<void>((resolve_1, reject_1) => {
			window.Main.send("analytics:track", "profile:add", "{}");
			showModal({
				title: t("profiles.addProfile"),
				body: (
					<div className={"flex flex-col gap-5 pt-2"}>
						<CustomButton
							onClickLoading={() => {
								return new Promise<void>((resolve, reject) => {
									if (window.Main) {
										window.Main.send("analytics:track", "profile:add:load_account", "{}");
										window.Main.on("settings:profile:add", (message: string) => {
											window.Main.removeAllListeners("settings:profile:add");
											const rawData = JSON.parse(message);
											if (rawData.error) {
												reject(rawData.error);
												reject_1();
												return;
											}
											refreshProfiles();
											resolve();
											closeModal();
											resolve_1();
										});
										window.Main.send("settings:profile:add", "current");
									} else {
										reject("No window.Main");
									}
								});
							}}
						>
							{t("profiles.loadFromAccount")}
						</CustomButton>
						<div className={"flex items-center gap-3"}>
							<span className={"h-px flex-1 bg-white/10"} />
							<span className={"text-xs uppercase tracking-wider text-gray-500"}>{t("profiles.or")}</span>
							<span className={"h-px flex-1 bg-white/10"} />
						</div>
						<div className={"flex items-end gap-3"}>
							<TextField className={"flex-1"}>
								<Label>{t("profiles.shareCode")}</Label>
								<Input id={"share-code"} placeholder={t("profiles.shareCodePlaceholder")} />
							</TextField>
							<CustomButton
								className={"shrink-0"}
								onClickLoading={() => {
									return new Promise<void>(async (resolve, reject) => {
										if (window.Main) {
											window.Main.send("analytics:track", "profile:add:load_share", "{}");
											const input = window.document.getElementById("share-code") as HTMLInputElement;
											const inputData = input.value;
											if (!inputData) {
												reject(t("profiles.noInputData"));
												return;
											}
											if (inputData.length != 10) {
												reject(t("profiles.invalidShareCode"));
												return;
											}
											const data = await getData(inputData);
											if (!data) {
												reject(t("profiles.invalidDataReturned"));
											}
											const save = () => {
												window.Main.on("settings:profile:add", (message: string) => {
													window.Main.removeAllListeners("settings:profile:add");
													const rawData = JSON.parse(message);
													if (rawData.error) {
														reject(rawData.error);
														reject_1();
														return;
													}
													refreshProfiles();
													resolve();
													closeModal();
													resolve_1();
												});
												window.Main.send("settings:profile:add", "clipboard");
											};
											const match = !data.match(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
											if (data.length < 2500 || match) {
												window.Main.send(
													"analytics:track",
													"profile:add:load_clipboard:error",
													JSON.stringify({ length: data.length, match }),
												);
												showModal({
													title: t("profiles.doesntLookLikeProfile"),
													body: t("profiles.doesntLookLikeProfileBody"),
													footer: (
														<>
															<CustomButton
																className={"mr-4"}
																color={"danger"}
																onPress={() => {
																	closeModal();
																	reject();
																	reject_1();
																}}
															>
																{t("common.cancel")}
															</CustomButton>
															<CustomButton onPress={() => { save(); }}>
																{t("common.continue")}
															</CustomButton>
														</>
													),
													onClose: () => {
														reject();
														reject_1();
													},
												});
											} else {
												save();
											}
										} else {
											reject("No window.Main");
										}
									});
								}}
							>
								<FaPlus />
							</CustomButton>
						</div>
					</div>
				),
				footer: (
					<CustomButton
						className={"w-full"}
						color={"danger"}
						onPress={() => {
							closeModal();
							reject_1();
						}}
					>
						{t("common.cancel")}
					</CustomButton>
				),
				onClose: () => {
					resolve_1();
				},
			});
		});

	const loadProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			if (window.Main) {
				window.Main.send("analytics:track", "profile:load", "{}");
				window.Main.on("settings:profile:load", (message: string) => {
					window.Main.removeAllListeners("settings:profile:load");
					const rawData = JSON.parse(message);
					if (rawData.error) {
						reject(rawData.error);
						return;
					}
					showModal({
						title: t("profiles.loadSuccess"),
						body: (
							<div className="glass p-4">
								<p className="text-green-400 font-semibold text-center">
									{t("profiles.loadSuccessMessage", { name: profile.name })}
								</p>
								<p className="text-sm text-gray-300 text-center mt-2">{t("profiles.loadSuccessDetail")}</p>
							</div>
						),
						footer: (
							<CustomButton className="w-full" color="success" onPress={closeModal}>
								{t("common.close")}
							</CustomButton>
						),
					});
					resolve();
				});
				window.Main.send("settings:profile:load", profile.name);
			} else {
				reject("No window.Main");
			}
		});

	const renameProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			showModal({
				title: t("profiles.editProfile"),
				body: (
					<div id={"edit-profile-div"}>
						<TextField defaultValue={profile.name}>
							<Label>{t("common.name")}</Label>
							<Input />
						</TextField>
					</div>
				),
				footer: (
					<>
						<CustomButton
							className={"mr-4"}
							color={"danger"}
							onPress={() => {
								closeModal();
								resolve();
							}}
						>
							{t("common.cancel")}
						</CustomButton>
						<CustomButton
							onPress={() => {
								if (window.Main) {
									window.Main.send("analytics:track", "profile:edit", "{}");
									window.Main.on("settings:profile:rename", (message: string) => {
										window.Main.removeAllListeners("settings:profile:rename");
										const rawData = JSON.parse(message);
										if (!rawData.success) {
											reject(rawData.error);
											return;
										}
										refreshProfiles();
										resolve();
										closeModal();
									});
									const document = window.document.getElementById("edit-profile-div");
									if (!document) {
										reject("No document");
										return;
									}
									const input = document.querySelector("input");
									if (!input) {
										reject("No input found");
										return;
									}
									window.Main.send("settings:profile:rename", profile.name, input.value);
								} else {
									reject("No window.Main");
								}
							}}
						>
							{t("common.save")}
						</CustomButton>
					</>
				),
				onClose: () => {
					resolve();
				},
			});
		});

	const duplicateProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			if (window.Main) {
				window.Main.send("analytics:track", "profile:duplicate", "{}");
				window.Main.on("settings:profile:duplicate", (message: string) => {
					window.Main.removeAllListeners("settings:profile:duplicate");
					const rawData = JSON.parse(message);
					if (rawData.error) {
						reject(rawData.error);
						return;
					}
					refreshProfiles();
					resolve();
				});
				window.Main.send("settings:profile:duplicate", profile.name);
			} else {
				reject("No window.Main");
			}
		});

	const viewProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			if (window.Main) {
				window.Main.send("analytics:track", "profile:view", "{}");
				window.Main.on("settings:profile:view", (message: string) => {
					const rawData = JSON.parse(message);
					if (rawData.error) {
						reject(rawData.error);
						window.Main.removeAllListeners("settings:profile:view");
						return;
					}
					showModal({
						title: t("settingsViewer.modalTitle", { name: profile.name }),
						body: <ViewSettingsModalBody data={rawData} />,
						footer: (
							<CustomButton
								className="w-full"
								color="danger"
								onPress={() => {
									closeModal();
									resolve();
								}}
							>
								{t("common.close")}
							</CustomButton>
						),
						onClose: () => {
							resolve();
						},
					});
					window.Main.removeAllListeners("settings:profile:view");
				});
				window.Main.send("settings:profile:view", profile.name);
			} else {
				reject("No window.Main");
			}
		});

	const compareProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			const otherProfiles = profiles.filter((p) => p.name !== profile.name);
			showModal({
				title: t("profiles.compareWith", { name: profile.name }),
				body: (
					<div className="flex flex-col gap-2 pt-2">
						<CustomButton
							className="w-full"
							color="secondary"
							onPress={() => {
								closeModal();
								compareProfileWithCurrent(profile.name, resolve, reject);
							}}
						>
							{t("profiles.currentAccount")}
						</CustomButton>
						{otherProfiles.map((other) => (
							<CustomButton
								key={other.name}
								className="w-full"
								onPress={() => {
									closeModal();
									compareTwoProfiles(profile.name, other.name, resolve, reject);
								}}
							>
								{other.name}
							</CustomButton>
						))}
					</div>
				),
				footer: (
					<CustomButton className="w-full" color="danger" onPress={() => { closeModal(); resolve(); }}>
						{t("common.cancel")}
					</CustomButton>
				),
				onClose: () => resolve(),
			});
		});

	const shareProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			if (window.Main) {
				window.Main.send("analytics:track", "profile:share", "{}");
				window.Main.on("settings:profile:share", (message: string) => {
					window.Main.removeAllListeners("settings:profile:share");
					const rawData = JSON.parse(message);
					if (rawData.error) {
						reject(rawData.error);
						return;
					}
					showModal({
						title: t("profiles.shareProfile"),
						body: (
							<div className={"pt-4"}>
								<TextField defaultValue={rawData.code} isReadOnly>
									<Label>{t("profiles.shareCode")}</Label>
									<Input />
								</TextField>
								<span className={"text-gray-400"}>{t("profiles.shareExpiry")}</span>
							</div>
						),
						footer: (
							<>
								<CustomButton
									className={"w-full"}
									onClickLoading={() => {
										return new Promise<void>((resolve, reject) => {
											if (window.Main) {
												window.Main.send("analytics:track", "profile:share:copy", "{}");
												window.Main.send("clipboard:set", rawData.code);
												resolve();
											} else {
												reject("No window.Main");
											}
										});
									}}
								>
									{t("common.copy")}
								</CustomButton>
								<CustomButton
									className={"w-full"}
									color={"danger"}
									onPress={() => {
										closeModal();
										resolve();
									}}
								>
									{t("common.close")}
								</CustomButton>
							</>
						),
					});
					resolve();
				});
				window.Main.send("settings:profile:share", profile.name);
			} else {
				reject("No window.Main");
			}
		});

	const removeProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			if (window.Main) {
				window.Main.send("analytics:track", "profile:remove", "{}");
				window.Main.on("settings:profile:remove", (message: string) => {
					window.Main.removeAllListeners("settings:profile:remove");
					const rawData = JSON.parse(message);
					if (rawData.error || !rawData.success) {
						reject(rawData.error ?? "Failed to remove profile");
						return;
					}
					refreshProfiles();
					resolve();
				});
				window.Main.send("settings:profile:remove", profile.name);
			} else {
				reject("No window.Main");
			}
		});

	// --- Render -------------------------------------------------------------

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader
				icon={<FaCogs className="text-[#ff4655] text-lg" />}
				title={t("profiles.title")}
				subtitle={t("profiles.savedCount", { count: profiles.length })}
			>
				<CustomButton size="sm" onClickLoading={addProfile}>
					<FaPlus />
					{t("profiles.addProfile")}
				</CustomButton>
			</PageHeader>

			<div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 flex flex-col gap-4">
				{/* Load only applies on the next game launch, so this needs to stay visible. */}
				<div className="glass rounded-2xl px-4 py-3 flex items-center gap-3">
					<FaTriangleExclamation className="text-amber-400 shrink-0" />
					<p className="text-sm text-gray-300">
						<Trans i18nKey="profiles.gameClosedWarning" components={{ bold: <b className="text-amber-300 font-semibold" /> }} />
					</p>
				</div>

				{profiles.length === 0 ? (
					<div className="flex-1 flex flex-col items-center justify-center gap-2 text-gray-500">
						<FaUsers className="text-4xl opacity-30" />
						<p className="text-sm text-gray-400">{t("profiles.noProfilesYet")}</p>
						<p className="text-xs">
							<Trans i18nKey="profiles.noProfilesHint" components={{ bold: <b className="text-gray-300" /> }} />
						</p>
					</div>
				) : (
					<SectionCard title={t("profiles.savedProfiles")} count={profiles.length} accent="#ff4655">
						{profiles.map((profile) => (
							<SectionRow key={profile.name}>
								<div className="w-9 h-9 rounded-md bg-white/5 flex items-center justify-center text-[#ff4655] shrink-0">
									<FaCogs className="text-sm" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold text-white truncate">{profile.name}</p>
									<p className="text-xs text-gray-500">{formatUnixMillis(profile.created)}</p>
								</div>
								<div className="flex items-center gap-1 shrink-0">
									<CustomButton size="sm" className="mr-1" onClickLoading={() => loadProfile(profile)}>
										{t("common.load")}
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} aria-label={t("profiles.editProfile")} onClickLoading={() => renameProfile(profile)}>
										<FaEdit />
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} aria-label={t("profiles.duplicate")} onClickLoading={() => duplicateProfile(profile)}>
										<FaCopy />
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} aria-label={t("profiles.view")} onClickLoading={() => viewProfile(profile)}>
										<FaEye />
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} aria-label={t("profiles.settingsDiff")} onClickLoading={() => compareProfile(profile)}>
										<FaCodeCompare />
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} aria-label={t("profiles.shareProfile")} onClickLoading={() => shareProfile(profile)}>
										<FaShare />
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} color="danger" aria-label={t("profiles.delete")} onClickLoading={() => removeProfile(profile)}>
										<FaTrash />
									</CustomButton>
								</div>
							</SectionRow>
						))}
					</SectionCard>
				)}
			</div>
		</div>
	);
};

export default SettingsProfiles;
