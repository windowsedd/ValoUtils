import React, { useEffect } from "react";
import { gooeyToast as toast } from "goey-toast";
import { useTranslation } from "react-i18next";
import { FaCheck, FaX } from "react-icons/fa6";
import { Button, type ButtonProps } from "@/components/ui/button";
import { runButtonAction } from "./button-action";

// Built on the shadcn/ui Button. The `color`, `size`, `isDisabled`,
// `isLoading` and `onPress` props from the HeroUI era are kept so callers
// don't change; they map onto shadcn variants here.
type ButtonColor = "default" | "primary" | "secondary" | "danger" | "success";
type ButtonSize = "sm" | "md" | "lg";
type PressEvent = React.MouseEvent<HTMLButtonElement>;

const colorToVariant: Record<ButtonColor, NonNullable<ButtonProps["variant"]>> = {
	default: "default",
	primary: "default",
	secondary: "secondary",
	danger: "destructive",
	success: "success",
};

const sizeToVariant: Record<ButtonSize, NonNullable<ButtonProps["size"]>> = {
	sm: "sm",
	md: "default",
	lg: "lg",
};

type CustomButtonProps = {
	onClickLoading?: (e: PressEvent) => Promise<any>;
	onClick?: (e: PressEvent) => void;
	onPress?: (e: PressEvent) => void;
	toggle?: [boolean, React.Dispatch<React.SetStateAction<boolean>>];
	color?: ButtonColor;
	size?: ButtonSize;
	isLoading?: boolean;
	isDisabled?: boolean;
	modalOnError?: boolean;
	showStatusColor?: boolean;
	closeModal?: () => void;
	children?: React.ReactNode;
} & Omit<ButtonProps, "color" | "size" | "onClick" | "variant" | "children" | "pending">;

const CustomButton = ({ modalOnError = true, showStatusColor = false, ...props }: CustomButtonProps) => {
	const { t } = useTranslation();
	const pending = React.useRef(false);
	const [loading, setLoading] = React.useState(false);
	const [statusIcon, setStatusIcon] = React.useState<React.ReactNode | null>(null);
	const [btnColor, setBtnColor] = React.useState<ButtonColor>(props.color ?? "primary");
	useEffect(() => {
		setBtnColor(props.color ?? "primary");
	}, [props.color]);

	// Strip our own props so the rest can be spread onto the shadcn Button.
	const {
		onClickLoading,
		onClick,
		onPress,
		toggle,
		color: _color,
		size,
		closeModal: _closeModal,
		isLoading,
		isDisabled,
		disabled,
		children,
		...rest
	} = props;

	return (
		<Button
			type="button"
			variant={colorToVariant[btnColor]}
			size={sizeToVariant[size ?? "md"]}
			pending={loading || isLoading}
			disabled={disabled || isDisabled}
			onClick={async (e: PressEvent) => {
				if (onClickLoading) {
					if (pending.current || isLoading) return;
					pending.current = true;
					setLoading(true);
					try {
						const success = await runButtonAction(
							() => onClickLoading(e),
							(message) => {
								if (modalOnError) toast.error(message);
							},
							t("common.actionFailed"),
						);
						if (showStatusColor) {
							setBtnColor(success ? "success" : "danger");
							setStatusIcon(success ? <FaCheck /> : <FaX />);
							setTimeout(() => {
								setBtnColor(props.color ?? "primary");
								setStatusIcon(null);
								if (success) props.closeModal?.();
							}, 1000);
						}
					} finally {
						pending.current = false;
						setLoading(false);
					}
				} else if (onClick) {
					onClick(e);
				} else if (onPress) {
					onPress(e);
				} else if (toggle) {
					toggle[1](!toggle[0]);
				}
			}}
			{...rest}
		>
			{statusIcon}
			{children}
		</Button>
	);
};

export default CustomButton;
