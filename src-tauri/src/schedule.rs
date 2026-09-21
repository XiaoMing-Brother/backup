use chrono::{Datelike, Days, Local, NaiveTime, TimeZone};
use serde_json::Value;

pub fn valid_time(s: &str) -> bool {
    s.len() == 5 && NaiveTime::parse_from_str(s, "%H:%M").is_ok()
}

pub fn next(cfg: &Value, from: i64) -> Option<i64> {
    let mode = cfg["scheduleMode"].as_str().unwrap_or("interval");
    if mode == "interval" {
        return from.checked_add(
            cfg["intervalMinutes"]
                .as_i64()
                .unwrap_or(30)
                .clamp(1, 525600)
                * 60000,
        );
    }
    let base = Local.timestamp_millis_opt(from).single()?.date_naive();
    let times: Vec<&str> = if mode == "daily" {
        cfg["dailyTimes"]
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .collect()
    } else if mode == "weekly" {
        vec![cfg["weeklyTime"].as_str().unwrap_or("09:00")]
    } else {
        return None;
    };
    if times.is_empty() || (mode == "weekly" && cfg["weeklyDays"].as_array()?.is_empty()) {
        return Some(from + 86400000);
    }
    let mut candidates = vec![];
    for offset in 0..=8 {
        let date = base.checked_add_days(Days::new(offset))?;
        if mode == "weekly"
            && !cfg["weeklyDays"]
                .as_array()?
                .iter()
                .any(|v| v.as_u64() == Some(date.weekday().num_days_from_sunday() as u64))
        {
            continue;
        }
        for time in &times {
            let Ok(time) = NaiveTime::parse_from_str(time, "%H:%M") else {
                continue;
            };
            if let Some(dt) = Local.from_local_datetime(&date.and_time(time)).earliest() {
                if dt.timestamp_millis() > from {
                    candidates.push(dt.timestamp_millis());
                }
            }
        }
    }
    candidates.into_iter().min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn interval_daily_weekly() {
        let from = Local
            .with_ymd_and_hms(2026, 9, 9, 10, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            next(&json!({"intervalMinutes":30}), from),
            Some(from + 1800000)
        );
        let daily = next(
            &json!({"scheduleMode":"daily","dailyTimes":["18:00","09:00"]}),
            from,
        )
        .unwrap();
        assert_eq!(
            daily,
            Local
                .with_ymd_and_hms(2026, 9, 9, 18, 0, 0)
                .single()
                .unwrap()
                .timestamp_millis()
        );
        let weekly = next(
            &json!({"scheduleMode":"weekly","weeklyDays":[3],"weeklyTime":"09:00"}),
            from,
        )
        .unwrap();
        assert_eq!(
            weekly,
            Local
                .with_ymd_and_hms(2026, 9, 16, 9, 0, 0)
                .single()
                .unwrap()
                .timestamp_millis()
        );
        assert!(!valid_time("25:00"));
    }
}
