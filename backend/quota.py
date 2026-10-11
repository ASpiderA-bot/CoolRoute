import os
import time

import boto3
from botocore.exceptions import ClientError

_table = boto3.resource("dynamodb").Table(os.environ["QUOTA_TABLE"])
DAILY_CAP = int(os.environ.get("DAILY_ROUTE_CAP", "500"))


def reserve(units):
    """Atomically add `units` Location calls to today's count.
    Returns False, and changes nothing, if that would exceed the daily cap."""
    day = time.strftime("%Y-%m-%d", time.gmtime())
    try:
        _table.update_item(
            Key={"pk": "route#" + day},
            UpdateExpression="ADD used :u",
            # Succeeds only if the count before this call plus units <= cap
            ConditionExpression="attribute_not_exists(used) OR used <= :max_before",
            ExpressionAttributeValues={
                ":u": units,
                ":max_before": DAILY_CAP - units,
            },
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise

