import { useEffect } from "react";
import { Toast } from "@heroui/react";

type AlertContainerProps = {
    children: React.ReactNode | React.ReactNode[];
}
const AlertContainer = (props: AlertContainerProps) => {
    useEffect(() => {
        if (window.Main) {
            window.Main.on("alert:info", (message: string) => {
                Toast.toast.info(message);
            });
        }
    }, [])
    return (
        <>
            {props.children}
        </>
    );
};

export default AlertContainer;
