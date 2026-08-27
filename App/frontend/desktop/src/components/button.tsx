/** Button module. */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/** Contract for button props. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "soft" | "ghost" | "danger";
  size?: "sm" | "md";
  children: ReactNode;
}

/** Definition for button. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className = "", ...props },
  ref
) {
  return <button ref={ref} className={`button button-${variant} button-${size} ${className}`.trim()} {...props} />;
});
