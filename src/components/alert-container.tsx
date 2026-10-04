import { listenEvent } from "@/util/ipc";
import { isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { gooeyToast as toast } from "goey-toast";

type AlertContainerProps = {
    children: React.ReactNode | React.ReactNode[];
}
const AlertContainer = (props: AlertContainerProps) => {
    useEffect(() => {
        const onError = (event: Event) => toast.error((event as CustomEvent<string>).detail);
        window.addEventListener("valoutils:ipc-error", onError);
        const stop = isTauri() ? listenEvent<string>("alert:info", message => toast.info(message)) : () => {};
        return () => { stop(); window.removeEventListener("valoutils:ipc-error", onError); };
    }, []);
    return (
        <>
            {props.children}
        </>
    );
};

export default AlertContainer;
