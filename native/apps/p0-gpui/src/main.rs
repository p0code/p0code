mod app;
mod attachments;
mod bridge;
mod cards;
mod cli;
mod completions;
mod composer;
mod diff_panel;
mod explorer;
mod feed;
mod markdown;
mod palette;
mod right_panel;
mod settings;
mod terminal;
mod theme;

use clap::Parser as _;
use tracing_subscriber::EnvFilter;

use crate::bridge::AppBridge;
use crate::cli::Cli;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    if cli.smoke {
        if let Err(err) = AppBridge::run_smoke(&cli) {
            eprintln!("p0-gpui smoke failed: {err}");
            std::process::exit(1);
        }
        return;
    }

    let bridge = match AppBridge::start(&cli) {
        Ok(b) => b,
        Err(err) => {
            eprintln!("p0-gpui failed to initialize backend connection: {err}");
            std::process::exit(1);
        }
    };

    app::run_gui(bridge);
}
