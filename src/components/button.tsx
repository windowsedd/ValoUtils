import React, { ComponentProps, useEffect } from "react";
import { Button as HeroButton } from "@heroui/react";
import { gooeyToast as toast } from "goey-toast";
import { PressEvent } from "@react-types/shared";
import { useTranslation } from "react-i18next";
import { runButtonAction } from "./button-action";
import { FaCheck, FaX } from "react-icons/fa6";

// HeroUI v3 dropped the `color` prop in favour of `variant`, and renamed
// `isLoading` -> `isPending`. We keep accepting the old `color` names so callers
// don't have to change, and translate them to v3 variants here.
type ButtonColor = "default" | "primary" | "secondary" | "danger" | "success";
type ButtonVariant = ComponentProps<typeof HeroButton>["variant"];

const colorToVariant: Record<ButtonColor, ButtonVariant> = {
  default: "primary",
  primary: "primary",
  secondary: "secondary",
  danger: "danger",
  // v3 has no "success" variant; we render primary + a green override class.
  success: "primary",
};

type CustomButtonProps = {
  onClickLoading?: (e: PressEvent) => Promise<any>;
  onClick?: (e: PressEvent) => void;
  onPress?: (e: PressEvent) => void;
  toggle?: [boolean, React.Dispatch<React.SetStateAction<boolean>>];
  color?: ButtonColor;
  isLoading?: boolean;
  modalOnError?: boolean;
  showStatusColor?: boolean;
  closeModal?: () => void;
  children?: React.ReactNode;
} & Omit<ComponentProps<typeof HeroButton>, "color" | "onClick" | "onPress" | "variant" | "children">;

const CustomButton = ({ modalOnError = true, showStatusColor = false, ...props }: CustomButtonProps) => {
  const { t } = useTranslation();
  const pending = React.useRef(false);
  const [loading, setLoading] = React.useState(false);
  const [statusIcon, setStatusIcon] = React.useState<React.ReactNode | null>(null);
  const [btnColor, setBtnColor] = React.useState<ButtonColor>(props.color ?? "primary");
  useEffect(() => {
    setBtnColor(props.color ?? "primary");
  }, [props.color]);

  // Strip our custom props (and the ones we handle explicitly) so the rest can be
  // safely spread onto the HeroUI Button.
  const {
    onClickLoading,
    onClick,
    onPress,
    toggle,
    color: _color,
    closeModal: _closeModal,
    isLoading,
    className,
    children,
    ...rest
  } = props;

  const mergedClassName = [className, btnColor === "success" ? "!bg-green-600 !text-white" : ""]
    .filter(Boolean)
    .join(" ") || undefined;

  return (
    <HeroButton
      variant={colorToVariant[btnColor]}
      className={mergedClassName}
      isPending={loading || isLoading}
      onPress={async (e: PressEvent) => {
        if (onClickLoading) {
          if (pending.current || isLoading) return;
          pending.current = true;
          setLoading(true);
          try {
            const success = await runButtonAction(
              () => onClickLoading(e),
              message => { if (modalOnError) toast.error(message); },
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
    </HeroButton>
  );
};

export default CustomButton;
