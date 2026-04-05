"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, User } from "lucide-react";

import { Button, buttonVariants } from "@my-better-t-app/ui/components/button";
import { useAuth } from "@/context/auth";
import { ModeToggle } from "./mode-toggle";

export default function Header() {
  const { isAuthenticated, username, logout } = useAuth();
  const router = useRouter();

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  return (
    <div>
      <div className="flex flex-row items-center justify-between px-2 py-1">
        <nav className="flex gap-4 text-lg">
          <Link href="/">Home</Link>
          {isAuthenticated && (
            <>
              <Link href="/recorder">Recorder</Link>
              <Link href="/history">History</Link>
            </>
          )}
        </nav>

        <div className="flex items-center gap-2">
          <ModeToggle />
          {isAuthenticated ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <User className="size-3.5" />
                {username}
              </span>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleLogout}>
                <LogOut className="size-3.5" />
                Sign out
              </Button>
            </div>
          ) : (
            <Link href="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Sign in
            </Link>
          )}
        </div>
      </div>
      <hr />
    </div>
  );
}
