import CustomButton from "@/components/button.tsx";
import { useDynamicModal } from "@/components/dynamic-modal.tsx";
import { ParsedSettingsViewer } from "@/components/parsed-settings-viewer.tsx";
import { Profile } from "@/types/profile.ts";
import formatUnixMillis from "@/util/format-date.ts";
import { Input, Label, Table, TextField } from "@heroui/react";
import { useEffect, useState } from "react";
import { FaEdit } from "react-icons/fa";
import { FaCopy, FaEye, FaPlus, FaShare, FaTrash, FaUsers } from "react-icons/fa6";
import { getData } from "../../electron/util/share.ts";

const ViewSettingsModalBody = ({ data }: { data: any }) => (
	<ParsedSettingsViewer rawSettings={data?.settings} crosshairData={data?.crosshairs ?? null} />
);

const SettingsProfiles = () => {
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const { showModal, closeModal } = useDynamicModal();
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
	return (
		<div className="px-6 py-8 h-full flex flex-col animate-fade-in">
			<div className="glass-strong p-6 mb-6 card-hover shrink-0">
				<div className="flex items-center justify-between flex-wrap gap-4">
					<h1 className="text-5xl font-bold gradient-text">Profiles</h1>
					<CustomButton
						onClickLoading={() => {
							return new Promise<void>((resolve_1, reject_1) => {
								window.Main.send("analytics:track", "profile:add", "{}");
								showModal({
									title: "Add Profile",
									body: (
										<div className={"flex flex-col gap-4"}>
											<CustomButton
												onClickLoading={() => {
													return new Promise<void>((resolve, reject) => {
														if (window.Main) {
															window.Main.send("analytics:track", "profile:add:load_account", "{}");
															window.Main.on("settings:profile:add", (message: string) => {
																const rawData = JSON.parse(message);
																if (rawData.error) {
																	reject(rawData.error);
																	reject_1();
																	return;
																}
																resolve();
																closeModal();
																resolve_1();
																window.Main.removeAllListeners("settings:profile:add");
															});
															window.Main.send("settings:profile:add", "current");
														} else {
															reject("No window.Main");
														}
													});
												}}
											>
												Load from account
											</CustomButton>
											<div className={"flex-row flex h-full"}>
												<TextField className={"w-4/5"}>
													<Label>Share Code</Label>
													<Input id={"share-code"} />
												</TextField>
												<CustomButton
													className={
														"h-full w-fit ml-4 " + "py-5" // TODO figure out why the height isn't working
													}
													onClickLoading={() => {
														return new Promise<void>(async (resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:add:load_share", "{}");
																const input = window.document.getElementById("share-code") as HTMLInputElement;
																const inputData = input.value;
																if (!inputData) {
																	reject("No input data");
																	return;
																}
																if (inputData.length != 10) {
																	reject("Invalid share code");
																	return;
																}
																const data = await getData(inputData);
																if (!data) {
																	reject("Invalid data returned by server");
																}
																const save = () => {
																	window.Main.on("settings:profile:add", (message: string) => {
																		const rawData = JSON.parse(message);
																		if (rawData.error) {
																			reject(rawData.error);
																			reject_1();
																			return;
																		}
																		resolve();
																		closeModal();
																		resolve_1();
																		window.Main.removeAllListeners("settings:profile:add");
																	});
																	window.Main.send("settings:profile:add", "clipboard");
																};
																const match = !data.match(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
																if (data.length < 2500 || match) {
																	// if it's not base64 or it's too short to be a profile
																	window.Main.send(
																		"analytics:track",
																		"profile:add:load_clipboard:error",
																		JSON.stringify({
																			length: data.length,
																			match,
																		}),
																	);
																	showModal({
																		title: "This doesn't look like a profile",
																		body: "This doesn't look like a profile! Are you sure you want to continue?",
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
																					Cancel
																				</CustomButton>
																				<CustomButton
																					onPress={() => {
																						save();
																					}}
																				>
																					Continue
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
												reject_1(); // TODO figure out why closeModal() doesn't fire onClose
											}}
										>
											Cancel
										</CustomButton>
									),
									onClose: () => {
										resolve_1();
									},
								});
							});
						}}
					>
						<FaPlus />
						Add
					</CustomButton>
				</div>
			</div>
			<div className="glass p-4 mb-6 shrink-0">
				<p className="text-center text-gray-300">
					Make sure you have the game <b className="text-red-400 font-bold">CLOSED</b>, and Riot Client should be open.
				</p>
			</div>

			<div className="glass-strong p-6 flex-1 flex flex-col min-h-0">
				{profiles.length === 0 ? (
					<div className="flex-1 flex flex-col items-center justify-center text-center gap-3 text-gray-400">
						<FaUsers className="text-5xl text-gray-500" />
						<p className="text-lg font-semibold text-gray-300">No profiles yet</p>
						<p className="text-sm">
							Click <b className="text-white">+ Add</b> above to create your first profile.
						</p>
					</div>
				) : (
					<Table className="bg-transparent flex-1">
						<Table.ScrollContainer>
							<Table.Content aria-label={"Profiles"}>
								<Table.Header>
									<Table.Column id="name" isRowHeader>
										Name
									</Table.Column>
									<Table.Column id="created">Created On</Table.Column>
									<Table.Column id="actions">Actions</Table.Column>
								</Table.Header>
								<Table.Body>
									{profiles.map((profile, i) => (
										<Table.Row key={i} id={profile.name}>
											<Table.Cell>{profile.name}</Table.Cell>
											<Table.Cell>{formatUnixMillis(profile.created)}</Table.Cell>
											<Table.Cell>
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:load", "{}");
																window.Main.on("settings:profile:load", (message: string) => {
																	const rawData = JSON.parse(message);
																	if (rawData.error) {
																		reject(rawData.error);
																		return;
																	}

																	// Show success modal with loaded profile info
																	showModal({
																		title: "Profile Loaded Successfully",
																		body: (
																			<div className="glass p-4">
																				<p className="text-green-400 font-semibold text-center">✓ Profile "{profile.name}" has been loaded!</p>
																				<p className="text-sm text-gray-300 text-center mt-2">The profile settings have been applied to your Valorant configuration.</p>
																			</div>
																		),
																		footer: (
																			<CustomButton className="w-full" color="success" onPress={closeModal}>
																				Close
																			</CustomButton>
																		),
																	});
																	resolve();
																	window.Main.removeAllListeners("settings:profile:load");
																});
																window.Main.send("settings:profile:load", profile.name);
															} else {
																reject("No window.Main");
															}
														});
													}}
												>
													Load
												</CustomButton>
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
															showModal({
																title: "Edit Profile",
																body: (
																	<div id={"edit-profile-div"}>
																		<TextField defaultValue={profile.name}>
																			<Label>Name</Label>
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
																			Cancel
																		</CustomButton>
																		<CustomButton
																			onPress={() => {
																				if (window.Main) {
																					window.Main.send("analytics:track", "profile:edit", "{}");
																					window.Main.on("settings:profile:rename", (message: string) => {
																						const rawData = JSON.parse(message);
																						if (!rawData.success) {
																							reject(rawData.error);
																							return;
																						}
																						resolve();
																						closeModal();
																						window.Main.removeAllListeners("settings:profile:rename");
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
																			Save
																		</CustomButton>
																	</>
																),
																onClose: () => {
																	resolve();
																},
															});
														});
													}}
												>
													<FaEdit />
												</CustomButton>
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:duplicate", "{}");
																window.Main.on("settings:profile:duplicate", (message: string) => {
																	const rawData = JSON.parse(message);
																	if (rawData.error) {
																		reject(rawData.error);
																		return;
																	}
																	resolve();
																	window.Main.removeAllListeners("settings:profile:duplicate");
																});
																window.Main.send("settings:profile:duplicate", profile.name);
															} else {
																reject("No window.Main");
															}
														});
													}}
												>
													<FaCopy />
												</CustomButton>
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
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
																		title: `Settings — ${profile.name}`,
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
																				Close
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
													}}
												>
													<FaEye />
												</CustomButton>
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:share", "{}");
																window.Main.on("settings:profile:share", (message: string) => {
																	const rawData = JSON.parse(message);
																	if (rawData.error) {
																		reject(rawData.error);
																		return;
																	}
																	showModal({
																		title: "Share Profile",
																		body: (
																			<div className={"pt-4"}>
																				<TextField defaultValue={rawData.code} isReadOnly>
																					<Label>Share Code</Label>
																					<Input />
																				</TextField>
																				<span className={"text-gray-400"}>The share code will expire in 90 days.</span>
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
																					Copy
																				</CustomButton>
																				<CustomButton
																					className={"w-full"}
																					color={"danger"}
																					onPress={() => {
																						closeModal();
																						resolve();
																					}}
																				>
																					Close
																				</CustomButton>
																			</>
																		),
																	});
																	resolve();
																	window.Main.removeAllListeners("settings:profile:share");
																});
																window.Main.send("settings:profile:share", profile.name);
															} else {
																reject("No window.Main");
															}
														});
													}}
												>
													<FaShare />
												</CustomButton>
												<CustomButton
													size="sm"
													className={""}
													color={"danger"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:remove", "{}");
																window.Main.on("settings:profile:remove", (message: string) => {
																	const rawData = JSON.parse(message);
																	if (rawData.error) {
																		reject(rawData.error);
																	}
																});
																window.Main.send("settings:profile:remove", profile.name);
																resolve();
															} else {
																reject("No window.Main");
															}
														});
													}}
												>
													<FaTrash />
												</CustomButton>
											</Table.Cell>
										</Table.Row>
									))}
								</Table.Body>
							</Table.Content>
						</Table.ScrollContainer>
					</Table>
				)}
			</div>
		</div>
	);
};

export default SettingsProfiles;
