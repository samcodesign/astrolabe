// Release builds must not attach a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    poe_planner_lib::run()
}
