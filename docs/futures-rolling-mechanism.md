# Futures Rolling Mechanism

## Overview

Some commodities markets derive their pricing from futures contracts during market hours. Because futures contracts expire, the index price handles "rolling" the pricing to the next month's contract via a 5 day roll between the 5th and 10th business day of the month.

## Rolling Process

During the roll period, 20% of the weight is shifted back from the current month to the next month at 5:30 ET every business day until the current month is at 0% weight. Note that this happens during after hours, as markets are closed between 5 and 6 ET.

Currently this only applies to the WTIOIL market.

## Rolling Schedule

| Business Day | Front Month Weight | Next Month Weight |
| --- | --- | --- |
| 5 | 100% | 0% |
| 6 | 80% | 20% |
| 7 | 60% | 40% |
| 8 | 40% | 60% |
| 9 | 20% | 80% |
| 10 | 0% | 100% |
